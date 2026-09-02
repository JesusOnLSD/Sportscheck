require('dotenv').config();
const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const standingsRoute = require('./routes/standings');
const gamesRoute = require('./routes/games');
const aiRoute = require('./routes/ai');
const newsRoute = require('./routes/news');
const db = require('./db');

const app = express();
app.use(express.json());

// API routes — all still here and functional, they just have nothing to
// read yet since no scraper or provider is populating the database in
// this pass. Kept mounted so the frontend's existing fetch calls (once
// re-enabled) don't need route changes later — same tables, same shapes,
// just empty for now.
app.use('/api/standings', standingsRoute);
app.use('/api/games', gamesRoute);
app.use('/api/ai', aiRoute);
app.use('/api/news', newsRoute);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    time: new Date().toISOString()
  });
});

// Runs a Python script as a subprocess and parses its stdout as JSON.
// fetch_standings.py (and anything else added later) always prints valid
// JSON, even on failure — {"success": false, "error": "..."} — so this
// tries to parse stdout even when the process exits non-zero, rather than
// only trusting the "happy path". Only falls back to a generic error if
// stdout genuinely isn't JSON at all (e.g. python3 not found, wrong path).
async function runPythonScript(scriptPath, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync('python3', [scriptPath, ...args], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    });
    if (stderr) console.error(`[scraper stderr] ${stderr}`);
    return JSON.parse(stdout.trim());
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout.trim());
      } catch (parseErr) {
        // stdout wasn't JSON either — a genuine crash before the script
        // even got to its own try/except (e.g. python3 itself missing).
      }
    }
    return { success: false, error: err.message };
  }
}

// Diagnostic: is python3 even reachable in this environment at all? This
// is the first thing to check if anything below fails mysteriously —
// Render's Node runtime having Python available isn't guaranteed, and
// this gives a clear yes/no instead of a confusing downstream error.
app.get('/api/admin/python-check', async (req, res) => {
  try {
    const { stdout } = await execFileAsync('python3', ['--version']);
    res.json({ pythonAvailable: true, version: stdout.trim() });
  } catch (err) {
    res.json({ pythonAvailable: false, error: err.message });
  }
});

// Cooldown, tracked separately PER ENDPOINT rather than one shared timer.
// The Python rate limiter (50/min) only protects calls *within* one
// script's run — each spawn is a fresh process, so its in-memory timing
// resets every time. This is the separate protection against rapid
// REPEATED invocations of the SAME endpoint — reloading the page a few
// times quickly, or mashing "Fetch now". Per-endpoint (not one shared
// clock) so a single deliberate action that legitimately calls two
// different endpoints back to back — standings, then fixtures — isn't
// incorrectly blocked on its second call.
const lastFetchTimes = {};
const FETCH_COOLDOWN_MS = 15000;

function checkFetchCooldown(res, key) {
  const now = Date.now();
  const last = lastFetchTimes[key] || 0;
  if (now - last < FETCH_COOLDOWN_MS) {
    const waitSec = Math.ceil((FETCH_COOLDOWN_MS - (now - last)) / 1000);
    res.status(429).json({ error: `Please wait ${waitSec}s before fetching ${key} again.` });
    return false;
  }
  lastFetchTimes[key] = now;
  return true;
}

// The one real pipeline for this pass: spawn the scraper, get Premier
// League standings, store them. Everything else (other leagues, other
// sports, other data types) follows this exact same pattern later.
app.post('/api/admin/fetch-standings', async (req, res) => {
  if (!checkFetchCooldown(res, 'standings')) return;
  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_standings.py');
  const result = await runPythonScript(scriptPath);

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Unknown scraper error' });
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO standings (league, season, position, team, played, won, drawn, lost, goals_for, goals_against, points, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(league, season, team) DO UPDATE SET
      position=excluded.position, played=excluded.played, won=excluded.won, drawn=excluded.drawn,
      lost=excluded.lost, goals_for=excluded.goals_for, goals_against=excluded.goals_against,
      points=excluded.points, updated_at=excluded.updated_at
  `);
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const r of result.standings) {
      upsert.run('Premier League', '2026', r.position, r.team, r.played, r.won, r.drawn, r.lost, r.goalsFor, r.goalsAgainst, r.points, now);
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  console.log(`[scraper] Fetched and stored ${count} Premier League standings rows`);
  res.json({ success: true, stored: count });
});

// Fetches a window of days (today ± 3) of Premier League fixtures.
app.post('/api/admin/fetch-fixtures', async (req, res) => {
  if (!checkFetchCooldown(res, 'fixtures')) return;
  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_fixtures.py');
  const result = await runPythonScript(scriptPath);

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Unknown scraper error' });
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO fixtures (fixture_id, league, season, kickoff_utc, home_team, away_team, venue, status, home_score, away_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fixture_id) DO UPDATE SET
      kickoff_utc=excluded.kickoff_utc, status=excluded.status, home_score=excluded.home_score,
      away_score=excluded.away_score, updated_at=excluded.updated_at
  `);
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const f of result.fixtures) {
      upsert.run(f.fixtureId, 'Premier League', '2026', f.kickoffUtc, f.homeTeam, f.awayTeam, null, f.status, f.homeScore, f.awayScore, now);
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  console.log(`[scraper] Fetched and stored ${count} Premier League fixtures`);
  res.json({ success: true, stored: count });
});

// Full match detail — core status, timeline incidents, all stats,
// lineups — for one specific fixture. This is what powers the Match
// Summary tab, and is meant to be called both on demand (clicking into a
// match) and repeatedly while that tab is open, to reflect a live score.
app.post('/api/admin/fetch-match-detail/:fixtureId', async (req, res) => {
  const { fixtureId } = req.params;
  if (!checkFetchCooldown(res, 'match-detail:' + fixtureId)) return;

  const fixture = db.prepare('SELECT home_team AS homeTeam, away_team AS awayTeam FROM fixtures WHERE fixture_id = ?').get(fixtureId);
  if (!fixture) {
    return res.status(404).json({ error: 'No cached fixture with that ID — fetch fixtures first.' });
  }

  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_match_detail.py');
  const result = await runPythonScript(scriptPath, [fixtureId]);

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Unknown scraper error' });
  }

  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO match_detail (fixture_id, core_json, stats_json, incidents_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fixture_id) DO UPDATE SET
        core_json=excluded.core_json, stats_json=excluded.stats_json, incidents_json=excluded.incidents_json, updated_at=excluded.updated_at
    `).run(fixtureId, JSON.stringify(result.core || null), JSON.stringify(result.stats || []), JSON.stringify(result.incidents || []), now);

    // Relabel home/away-keyed lineups with the fixture's real team names —
    // the Python side deliberately doesn't know these, Node already does.
    const raw = result.rawLineups;
    if (raw) {
      const upsertLineup = db.prepare(`
        INSERT INTO lineups (fixture_id, team, formation, players_json, confirmed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(fixture_id, team) DO UPDATE SET
          formation=excluded.formation, players_json=excluded.players_json, confirmed=excluded.confirmed, updated_at=excluded.updated_at
      `);
      const formations = raw.formation || {};
      if (raw.home && raw.home.length) {
        upsertLineup.run(fixtureId, fixture.homeTeam, formations.home || null, JSON.stringify(raw.home), 1, now);
      }
      if (raw.away && raw.away.length) {
        upsertLineup.run(fixtureId, fixture.awayTeam, formations.away || null, JSON.stringify(raw.away), 1, now);
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  console.log(`[scraper] Fetched and stored match detail for fixture ${fixtureId}`);
  res.json({ success: true, fixtureId });
});

// Serve the frontend (the HTML/CSS/JS files) as static assets.
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sportscheck backend running on port ${PORT}`);
  console.log('No scraper or scheduler active yet — frontend-only pass. Database is present but empty.');
});
