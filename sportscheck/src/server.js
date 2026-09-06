require('dotenv').config();
const path = require('path');
const express = require('express');
const { execFile, spawn } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const standingsRoute = require('./routes/standings');
const scorersRoute = require('./routes/scorers');
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
app.use('/api/scorers', scorersRoute);
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

// Diagnostic only, no cooldown — shows the raw scorers feed response so a
// "0 scorers" result can actually be diagnosed instead of guessed at.
app.get('/api/admin/scorers-debug', async (req, res) => {
  const scriptPath = path.join(__dirname, '..', 'scraper', 'debug_scorers.py');
  const result = await runPythonScript(scriptPath);
  res.json(result);
});

// Diagnostic only — tests whether a specific past season's standings and
// scorers resolve the same way the current season's already-proven
// mechanism does. Pass ?season=2023-2024 (defaults to 2023-2024 if omitted).
app.get('/api/admin/historical-season-debug', async (req, res) => {
  const season = req.query.season || '2023-2024';
  const scriptPath = path.join(__dirname, '..', 'scraper', 'debug_historical_season.py');
  const result = await runPythonScript(scriptPath, [season]);
  res.json(result);
});

// Diagnostic only — tests whether the day-offset fixtures feed actually
// returns real data at a specific far-back offset, or comes back empty.
// Pass ?offset=-700 (defaults to -700, about 23 months back, if omitted).
app.get('/api/admin/fixtures-offset-debug', async (req, res) => {
  const offset = req.query.offset || '-700';
  const scriptPath = path.join(__dirname, '..', 'scraper', 'debug_fixtures_offset.py');
  const result = await runPythonScript(scriptPath, [offset]);
  res.json(result);
});

// Diagnostic only — tests several candidate values for the unknown
// pagination token in the historical results feed, to empirically find
// the real pattern rather than guess from a single captured example.
app.get('/api/admin/results-pagination-debug', async (req, res) => {
  const activeTournament = req.query.tournament || 'dYlOSQOD';
  const countryCode = req.query.country || '198';
  const scriptPath = path.join(__dirname, '..', 'scraper', 'debug_results_pagination.py');
  const result = await runPythonScript(scriptPath, [activeTournament, countryCode]);
  res.json(result);
});

// Diagnostic only — shows every stored fixture for a league, unfiltered
// by date, exactly as stored. Lets a "date X shows nothing" report be
// checked against what actually landed, rather than guessing dates one
// at a time.
app.get('/api/admin/fixtures-debug', (req, res) => {
  const league = req.query.league || 'Premier League';
  const rows = db.prepare(`
    SELECT fixture_id AS fixtureId, kickoff_utc AS kickoffUtcRaw, home_team AS homeTeam, away_team AS awayTeam, status, updated_at AS updatedAt
    FROM fixtures WHERE league = ? ORDER BY kickoff_utc ASC
  `).all(league);
  res.json({ league, count: rows.length, fixtures: rows });
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

// Top scorers, current season only — same league/season scoping as
// standings, just a different data type.
app.post('/api/admin/fetch-scorers', async (req, res) => {
  if (!checkFetchCooldown(res, 'scorers')) return;
  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_top_scorers.py');
  const result = await runPythonScript(scriptPath);

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Unknown scraper error' });
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO scorers (league, season, rank, player, team, goals, assists, nationality, position_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(league, season, player, team) DO UPDATE SET
      rank=excluded.rank, goals=excluded.goals, assists=excluded.assists,
      nationality=excluded.nationality, position_name=excluded.position_name, updated_at=excluded.updated_at
  `);
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const r of result.scorers) {
      upsert.run('Premier League', '2026', r.rank, r.player, r.team, r.goals, r.assists, r.nationality, r.position, now);
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  console.log(`[scraper] Fetched and stored ${count} Premier League top scorers`);
  res.json({ success: true, stored: count });
});

// Historical season fetch — same standings/scorers storage as the
// current season, just for a specific past year. Frontend sends the
// short label ("2023-24" matching the dropdown), converted here into
// both Flashscore's full-year slug ("2023-2024") and the storage key
// (just the first year, "2023", matching the existing convention).
app.post('/api/admin/fetch-historical-season/:seasonLabel', async (req, res) => {
  const seasonLabel = req.params.seasonLabel;
  if (!checkFetchCooldown(res, 'historical-season:' + seasonLabel)) return;

  const firstYear = parseInt(seasonLabel.split('-')[0], 10);
  if (!firstYear || Number.isNaN(firstYear)) {
    return res.status(400).json({ error: 'Invalid season label format, expected e.g. "2023-24"' });
  }
  const fullSeasonSlug = `${firstYear}-${firstYear + 1}`;
  const storageSeasonKey = String(firstYear);

  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_historical_season.py');
  const result = await runPythonScript(scriptPath, [fullSeasonSlug]);

  if (!result.success) {
    return res.status(500).json({ error: result.error || 'Unknown scraper error' });
  }

  const now = new Date().toISOString();

  const upsertStanding = db.prepare(`
    INSERT INTO standings (league, season, position, team, played, won, drawn, lost, goals_for, goals_against, points, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(league, season, team) DO UPDATE SET
      position=excluded.position, played=excluded.played, won=excluded.won, drawn=excluded.drawn,
      lost=excluded.lost, goals_for=excluded.goals_for, goals_against=excluded.goals_against,
      points=excluded.points, updated_at=excluded.updated_at
  `);
  let standingsCount = 0;
  db.exec('BEGIN');
  try {
    for (const r of result.standings) {
      upsertStanding.run('Premier League', storageSeasonKey, r.position, r.team, r.played, r.won, r.drawn, r.lost, r.goalsFor, r.goalsAgainst, r.points, now);
      standingsCount++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  const upsertScorer = db.prepare(`
    INSERT INTO scorers (league, season, rank, player, team, goals, assists, nationality, position_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(league, season, player, team) DO UPDATE SET
      rank=excluded.rank, goals=excluded.goals, assists=excluded.assists,
      nationality=excluded.nationality, position_name=excluded.position_name, updated_at=excluded.updated_at
  `);
  let scorersCount = 0;
  db.exec('BEGIN');
  try {
    for (const r of result.scorers) {
      upsertScorer.run('Premier League', storageSeasonKey, r.rank, r.player, r.team, r.goals, r.assists, r.nationality, r.position, now);
      scorersCount++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }

  console.log(`[scraper] Fetched historical season ${fullSeasonSlug}: ${standingsCount} standings, ${scorersCount} scorers`);
  res.json({ success: true, seasonLabel, standingsStored: standingsCount, scorersStored: scorersCount });
});

// --- 5-year historical fixtures backfill ---
// TESTING SCOPE RIGHT NOW: defaults to ±4 weeks (~1 minute), not the full
// 5 years (30-60+ minutes) — see fetch_history.py for how to widen this
// once the rest of the pipeline is verified working. Even the light
// version runs as a background process rather than a normal awaited
// call, since ANY multi-minute run would exceed the 60-second timeout
// the quick fetch routes use.
let historyBackfillRunning = false;
let historyBackfillProgress = { totalPushed: 0, startedAt: null, lastUpdate: null };

app.post('/api/admin/start-history-backfill', (req, res) => {
  if (historyBackfillRunning) {
    return res.status(409).json({ error: 'A backfill is already running.' });
  }
  historyBackfillRunning = true;
  historyBackfillProgress = { totalPushed: 0, startedAt: new Date().toISOString(), lastUpdate: new Date().toISOString() };

  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_history.py');
  const baseUrl = `http://localhost:${PORT}`;
  const child = spawn('python3', [scriptPath, baseUrl]);

  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => console.log(`[history-backfill] ${line}`));
  });
  child.stderr.on('data', (data) => {
    console.error(`[history-backfill stderr] ${data.toString().trim()}`);
  });
  child.on('close', (code) => {
    historyBackfillRunning = false;
    console.log(`[history-backfill] process exited with code ${code}`);
  });
  child.on('error', (err) => {
    historyBackfillRunning = false;
    console.error(`[history-backfill] failed to start: ${err.message}`);
  });

  res.json({ started: true });
});

app.get('/api/admin/history-backfill-status', (req, res) => {
  res.json({ running: historyBackfillRunning, ...historyBackfillProgress });
});

// The backfill script pushes here as it goes — localhost only, so no
// external secret needed the way the old local-computer-to-Render push
// required one; this never leaves the machine.
app.post('/api/admin/ingest-history-fixtures', (req, res) => {
  const { league, games } = req.body;
  if (!league || !Array.isArray(games)) {
    return res.status(400).json({ error: 'Body must be { league, games: [...] }' });
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
    for (const g of games) {
      if (!g.fixtureId || !g.homeTeam || !g.awayTeam) continue;
      upsert.run(g.fixtureId, league, 'historical', g.kickoffUtc || null, g.homeTeam, g.awayTeam, null, g.status || null, g.homeScore != null ? g.homeScore : null, g.awayScore != null ? g.awayScore : null, now);
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }
  historyBackfillProgress.totalPushed += count;
  historyBackfillProgress.lastUpdate = now;
  console.log(`[history-backfill] stored ${count} historical fixtures (running total: ${historyBackfillProgress.totalPushed})`);
  res.json({ success: true, stored: count });
});

// --- Per-team match stats backfill ---
// Only fetches stats for a specific team's matches, only the ones not
// already stored, only when that team's General/Opponent stats actually
// get opened — not pre-fetched for every team in the league. Tracked per
// team name (not one global flag) since different matches can have
// different teams' backfills running around the same time.
const teamStatsBackfills = {}; // teamName -> { running, totalStored, startedAt, lastUpdate }

app.post('/api/admin/start-team-stats-backfill/:teamName', (req, res) => {
  const teamName = decodeURIComponent(req.params.teamName);
  if (teamStatsBackfills[teamName] && teamStatsBackfills[teamName].running) {
    return res.status(409).json({ error: `A stats backfill for ${teamName} is already running.` });
  }

  const rows = db.prepare(`
    SELECT f.fixture_id FROM fixtures f
    WHERE (f.home_team = ? OR f.away_team = ?) AND f.status = 'finished'
      AND NOT EXISTS (SELECT 1 FROM match_detail md WHERE md.fixture_id = f.fixture_id)
  `).all(teamName, teamName);

  const fixtureIds = rows.map((r) => r.fixture_id);
  if (fixtureIds.length === 0) {
    return res.json({ started: false, reason: 'Nothing to fetch — all of this team\'s stored matches already have stats.' });
  }

  teamStatsBackfills[teamName] = { running: true, totalStored: 0, startedAt: new Date().toISOString(), lastUpdate: new Date().toISOString(), totalToFetch: fixtureIds.length };

  const scriptPath = path.join(__dirname, '..', 'scraper', 'fetch_team_stats.py');
  const baseUrl = `http://localhost:${PORT}`;
  const child = spawn('python3', [scriptPath, baseUrl]);

  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => console.log(`[team-stats:${teamName}] ${line}`));
  });
  child.stderr.on('data', (data) => {
    console.error(`[team-stats:${teamName} stderr] ${data.toString().trim()}`);
  });
  child.on('close', (code) => {
    teamStatsBackfills[teamName].running = false;
    console.log(`[team-stats:${teamName}] process exited with code ${code}`);
  });
  child.on('error', (err) => {
    teamStatsBackfills[teamName].running = false;
    console.error(`[team-stats:${teamName}] failed to start: ${err.message}`);
  });

  child.stdin.write(JSON.stringify(fixtureIds));
  child.stdin.end();

  res.json({ started: true, totalToFetch: fixtureIds.length });
});

app.get('/api/admin/team-stats-backfill-status/:teamName', (req, res) => {
  const teamName = decodeURIComponent(req.params.teamName);
  res.json(teamStatsBackfills[teamName] || { running: false, totalStored: 0 });
});

// Lighter than fetch-match-detail's ingestion — stats only, since that's
// all this pipeline needs, not core/incidents/lineups too.
app.post('/api/admin/ingest-team-stats', (req, res) => {
  const { fixtureId, stats } = req.body;
  if (!fixtureId || !Array.isArray(stats)) {
    return res.status(400).json({ error: 'Body must be { fixtureId, stats: [...] }' });
  }
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO match_detail (fixture_id, core_json, stats_json, incidents_json, updated_at)
      VALUES (?, NULL, ?, '[]', ?)
      ON CONFLICT(fixture_id) DO UPDATE SET stats_json=excluded.stats_json, updated_at=excluded.updated_at
    `).run(fixtureId, JSON.stringify(stats), now);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Update whichever team's backfill this fixture belongs to, if any is running
  const fixture = db.prepare('SELECT home_team, away_team FROM fixtures WHERE fixture_id = ?').get(fixtureId);
  if (fixture) {
    [fixture.home_team, fixture.away_team].forEach((team) => {
      if (teamStatsBackfills[team]) {
        teamStatsBackfills[team].totalStored += 1;
        teamStatsBackfills[team].lastUpdate = now;
      }
    });
  }

  res.json({ success: true });
});

// --- Stats aggregation: Season / General / Opponent ---
// All three read from the exact same fixtures + match_detail tables —
// General and Season just filter by date range, Opponent filters General's
// same broader dataset down to head-to-head matches specifically. One
// underlying data source, three different WHERE clauses, not three
// separate collection pipelines.

const STAT_DEFINITIONS = [
  { key: 'Expected goals (xG)', label: 'xG per game', decimals: 2 },
  { key: 'Expected assists (xA)', label: 'xA per game', decimals: 2 },
  { key: 'Ball possession', label: 'Possession', suffix: '%' },
  { key: 'Total shots', label: 'Shots per game' },
  { key: 'Shots on target', label: 'Shots on target / game' },
  { key: 'Shots off target', label: 'Shots off target / game' },
  { key: 'Blocked shots', label: 'Blocked shots / game' },
  { key: 'Shots inside the box', label: 'Shots inside box / game' },
  { key: 'Shots outside the box', label: 'Shots outside box / game' },
  { key: 'Hit the woodwork', label: 'Hit woodwork / game' },
  { key: 'Big chances', label: 'Big chances / game' },
  { key: 'Corner kicks', label: 'Corners per game' },
  { key: 'Touches in opposition box', label: 'Touches in box / game' },
  { key: 'Accurate through passes', label: 'Through passes / game' },
  { key: 'Offsides', label: 'Offsides per game' },
  { key: 'Free kicks', label: 'Free kicks / game' },
  { key: 'Passes', label: 'Pass accuracy', isFraction: true, suffix: '%' },
  { key: 'Long passes', label: 'Long pass accuracy', isFraction: true, suffix: '%' },
  { key: 'Passes in final third', label: 'Final-third pass accuracy', isFraction: true, suffix: '%' },
  { key: 'Crosses', label: 'Cross accuracy', isFraction: true, suffix: '%' },
  { key: 'Throw ins', label: 'Throw ins / game' },
  { key: 'Fouls', label: 'Fouls per game' },
  { key: 'Tackles', label: 'Tackle success', isFraction: true, suffix: '%' },
  { key: 'Duels won', label: 'Duels won / game' },
  { key: 'Clearances', label: 'Clearances per game' },
  { key: 'Interceptions', label: 'Interceptions per game' },
  { key: 'Errors leading to shot', label: 'Errors leading to shot / game' },
  { key: 'Errors leading to goal', label: 'Errors leading to goal / game' },
  { key: 'Goalkeeper saves', label: 'Saves per game' },
  { key: 'xGOT faced', label: 'xG on target faced / game', decimals: 2 },
  { key: 'Goals prevented', label: 'Goals prevented / game', decimals: 2 },
  { key: 'Goal kicks', label: 'Goal kicks / game' },
  { key: 'Yellow cards', label: 'Yellow cards / game' },
  { key: 'Red cards', label: 'Red cards / game' }
];

function parseStatValue(raw) {
  if (raw == null) return null;
  const fracMatch = /\((\d+)\/(\d+)\)/.exec(raw);
  if (fracMatch) {
    const pctMatch = /^(-?\d+(\.\d+)?)/.exec(raw);
    return { value: pctMatch ? parseFloat(pctMatch[1]) : null, made: parseInt(fracMatch[1], 10), attempted: parseInt(fracMatch[2], 10) };
  }
  const pctOnly = /^(-?\d+(\.\d+)?)%$/.exec(raw);
  if (pctOnly) return { value: parseFloat(pctOnly[1]), made: null, attempted: null };
  const num = parseFloat(raw);
  return Number.isNaN(num) ? null : { value: num, made: null, attempted: null };
}

function aggregateStatsForFixtures(rows, perspectiveTeam) {
  const accum = {};
  STAT_DEFINITIONS.forEach((d) => { accum[d.key] = { sum: 0, count: 0, sumMade: 0, sumAttempted: 0 }; });

  let matchesWithStats = 0;
  rows.forEach((row) => {
    let stats;
    try { stats = JSON.parse(row.stats_json || '[]'); } catch (e) { return; }
    if (!stats || stats.length === 0) return;
    matchesWithStats++;
    const isHome = row.home_team === perspectiveTeam;
    const seen = new Set();
    stats.filter((s) => s.period === 'Match').forEach((s) => {
      if (seen.has(s.stat) || !accum[s.stat]) return;
      seen.add(s.stat);
      const parsed = parseStatValue(isHome ? s.home : s.away);
      if (!parsed) return;
      if (parsed.value != null) { accum[s.stat].sum += parsed.value; accum[s.stat].count += 1; }
      if (parsed.made != null) { accum[s.stat].sumMade += parsed.made; accum[s.stat].sumAttempted += parsed.attempted; }
    });
  });

  const stats = STAT_DEFINITIONS.map((d) => {
    const a = accum[d.key];
    let value = null;
    if (a.sumAttempted > 0) value = (a.sumMade / a.sumAttempted) * 100;
    else if (a.count > 0) value = a.sum / a.count;
    return { key: d.key, label: d.label, value, decimals: d.decimals || 1, suffix: d.suffix || '' };
  });

  return { matchesWithStats, stats };
}

// Current PL season runs roughly August-May — "current season" is
// everything from the most recent August 1st onward.
function currentSeasonStartDate() {
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // month 6 = July (0-indexed)
  return `${year}-08-01`;
}

// Win/draw/loss record from raw fixture scores — separate from the stats
// aggregation above since it needs ALL finished matches in range (even
// ones whose detailed stats haven't been backfilled yet), not just the
// ones with match_detail already stored.
function computeRecord(rows, perspectiveTeam) {
  let played = 0, won = 0, drawn = 0, lost = 0, goalsFor = 0, goalsAgainst = 0;
  rows.forEach((r) => {
    if (r.home_score == null || r.away_score == null) return;
    const isHome = r.home_team === perspectiveTeam;
    const gf = isHome ? r.home_score : r.away_score;
    const ga = isHome ? r.away_score : r.home_score;
    played++;
    goalsFor += gf;
    goalsAgainst += ga;
    if (gf > ga) won++;
    else if (gf < ga) lost++;
    else drawn++;
  });
  return { played, won, drawn, lost, goalsFor, goalsAgainst, points: won * 3 + drawn };
}

// Season stats — current season only.
app.get('/api/season-stats', (req, res) => {
  const { league, team } = req.query;
  if (!league || !team) return res.status(400).json({ error: 'league and team query params are required.' });
  const seasonStart = currentSeasonStartDate();

  const allFixtures = db.prepare(`
    SELECT home_team, away_team, home_score, away_score FROM fixtures
    WHERE league = ? AND (home_team = ? OR away_team = ?) AND status = 'finished' AND kickoff_utc >= ?
  `).all(league, team, team, seasonStart);
  const record = computeRecord(allFixtures, team);

  const statsRows = db.prepare(`
    SELECT f.home_team, f.away_team, md.stats_json
    FROM fixtures f JOIN match_detail md ON md.fixture_id = f.fixture_id
    WHERE f.league = ? AND (f.home_team = ? OR f.away_team = ?) AND f.status = 'finished'
      AND f.kickoff_utc >= ?
  `).all(league, team, team, seasonStart);
  const { matchesWithStats, stats } = aggregateStatsForFixtures(statsRows, team);

  res.json({ league, team, seasonStart, record, matchesFound: statsRows.length, matchesWithStats, stats });
});

// General stats — last 5 years/seasons, current season included.
app.get('/api/general-stats', (req, res) => {
  const { league, team } = req.query;
  if (!league || !team) return res.status(400).json({ error: 'league and team query params are required.' });

  const allFixtures = db.prepare(`
    SELECT home_team, away_team, home_score, away_score FROM fixtures
    WHERE league = ? AND (home_team = ? OR away_team = ?) AND status = 'finished' AND datetime(kickoff_utc) >= datetime('now', '-5 years')
  `).all(league, team, team);
  const record = computeRecord(allFixtures, team);

  const statsRows = db.prepare(`
    SELECT f.home_team, f.away_team, md.stats_json
    FROM fixtures f JOIN match_detail md ON md.fixture_id = f.fixture_id
    WHERE f.league = ? AND (f.home_team = ? OR f.away_team = ?) AND f.status = 'finished'
      AND datetime(f.kickoff_utc) >= datetime('now', '-5 years')
  `).all(league, team, team);
  const { matchesWithStats, stats } = aggregateStatsForFixtures(statsRows, team);

  res.json({ league, team, record, matchesFound: statsRows.length, matchesWithStats, stats });
});

// Opponent stats — the SAME 5-year window General stats uses, filtered
// down to just head-to-head matches between two specific teams. Not a
// separate collection or a separate call to /api/general-stats — same
// tables, same date window, just a narrower WHERE clause.
app.get('/api/opponent-stats-full', (req, res) => {
  const { league, teamA, teamB } = req.query;
  if (!league || !teamA || !teamB) return res.status(400).json({ error: 'league, teamA, and teamB query params are required.' });

  const rows = db.prepare(`
    SELECT f.home_team, f.away_team, md.stats_json
    FROM fixtures f JOIN match_detail md ON md.fixture_id = f.fixture_id
    WHERE f.league = ? AND f.status = 'finished' AND datetime(f.kickoff_utc) >= datetime('now', '-5 years')
      AND ((f.home_team = ? AND f.away_team = ?) OR (f.home_team = ? AND f.away_team = ?))
  `).all(league, teamA, teamB, teamB, teamA);

  const statsA = aggregateStatsForFixtures(rows, teamA);
  const statsB = aggregateStatsForFixtures(rows, teamB);
  res.json({ league, teamA, teamB, meetingsFound: rows.length, teamAStats: statsA.stats, teamBStats: statsB.stats });
});

// Fetches a fast, safe window (today ± 1 week) of Premier League fixtures,
// synchronously — the wider ±4 week view comes from start-history-backfill
// instead, which runs in the background specifically because it doesn't
// fit under this route's 60-second timeout (see fetch_fixtures.py).
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

// Head-to-head meetings list, paginated — 5 most recent by default, more
// via ?limit=10, ?limit=15, etc. ("load more" pattern on the frontend).
app.get('/api/h2h-meetings', (req, res) => {
  const { league, teamA, teamB } = req.query;
  const limit = parseInt(req.query.limit, 10) || 5;
  if (!league || !teamA || !teamB) return res.status(400).json({ error: 'league, teamA, and teamB query params are required.' });

  const rows = db.prepare(`
    SELECT fixture_id AS fixtureId, kickoff_utc AS kickoffUtc, home_team AS homeTeam, away_team AS awayTeam,
           home_score AS homeScore, away_score AS awayScore
    FROM fixtures
    WHERE league = ? AND status = 'finished'
      AND ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?))
      AND datetime(kickoff_utc) >= datetime('now', '-5 years')
    ORDER BY kickoff_utc DESC
    LIMIT ?
  `).all(league, teamA, teamB, teamB, teamA, limit);

  // Also report the true total so the frontend knows when "load more" has
  // genuinely run out, rather than just always offering another 5.
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM fixtures
    WHERE league = ? AND status = 'finished'
      AND ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?))
      AND datetime(kickoff_utc) >= datetime('now', '-5 years')
  `).get(league, teamA, teamB, teamB, teamA);

  res.json({ league, teamA, teamB, limit, total: totalRow.total, meetings: rows });
});

// Serve the frontend (the HTML/CSS/JS files) as static assets.
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Hourly scheduled data refresh ---
// Standings/fixtures/scorers are each a single cheap request no matter
// what, so those just refresh every run. Match detail is the expensive
// part (4 rate-limited calls per match), so it's the one place a real
// "memory" matters: skip any match already marked finished with stats
// already stored, since that data is locked in and will never change.
// Only fetch matches that are still live, still scheduled, or missing
// detail entirely — never re-fetch something we already have for good.
let scheduledFetchRunning = false;
const MAX_MATCH_DETAILS_PER_RUN = 100; // ~8 min of work per run (100 matches × 4 rate-limited calls each), comfortably under the 1hr window — clears a full 5-year backlog (~1900 matches) in about 19 hourly runs instead of 127
let fullCatchupProgress = { running: false, totalToFetch: 0, totalDone: 0, startedAt: null, lastUpdate: null };

// Shared by both the regular hourly job and the manual "fetch everything
// now" catch-up — same query, same per-match fetch, just a different
// LIMIT. Each match saves to the database immediately as it's fetched
// (not batched), so this is safe to interrupt at any point — nothing
// already done gets lost, unlike the earlier fixtures-backfill issue.
function findFixturesNeedingDetail(limit) {
  return db.prepare(`
    SELECT f.fixture_id FROM fixtures f
    LEFT JOIN match_detail md ON md.fixture_id = f.fixture_id
    WHERE datetime(f.kickoff_utc) <= datetime('now')
      AND (f.status != 'finished' OR md.fixture_id IS NULL OR md.stats_json IS NULL OR md.stats_json = '[]')
    ORDER BY f.kickoff_utc DESC
    LIMIT ?
  `).all(limit);
}

async function fetchMatchDetailsForList(fixtureRows, base, logPrefix, progressTracker) {
  for (const row of fixtureRows) {
    try {
      const r = await fetch(`${base}/api/admin/fetch-match-detail/${row.fixture_id}`, { method: 'POST' });
      const d = await r.json();
      console.log(`[${logPrefix}] match ${row.fixture_id}:`, d.success ? 'updated' : d.error);
    } catch (err) {
      console.error(`[${logPrefix}] match ${row.fixture_id} failed:`, err.message);
    }
    if (progressTracker) {
      progressTracker.totalDone += 1;
      progressTracker.lastUpdate = new Date().toISOString();
    }
  }
}

async function runScheduledFetch() {
  if (scheduledFetchRunning) {
    console.log('[scheduled-fetch] Previous run (or a manual catch-up) still in progress, skipping this tick.');
    return;
  }
  scheduledFetchRunning = true;
  const base = `http://localhost:${PORT}`;
  console.log('[scheduled-fetch] Starting...');

  try {
    const r = await fetch(`${base}/api/admin/fetch-standings`, { method: 'POST' });
    const d = await r.json();
    console.log('[scheduled-fetch] standings:', d.success ? `${d.stored} teams` : d.error);
  } catch (err) {
    console.error('[scheduled-fetch] standings failed:', err.message);
  }

  try {
    const r = await fetch(`${base}/api/admin/fetch-fixtures`, { method: 'POST' });
    const d = await r.json();
    console.log('[scheduled-fetch] fixtures:', d.success ? `${d.stored} fixtures` : d.error);
  } catch (err) {
    console.error('[scheduled-fetch] fixtures failed:', err.message);
  }

  try {
    const r = await fetch(`${base}/api/admin/fetch-scorers`, { method: 'POST' });
    const d = await r.json();
    console.log('[scheduled-fetch] scorers:', d.success ? `${d.stored} scorers` : d.error);
  } catch (err) {
    console.error('[scheduled-fetch] scorers failed:', err.message);
  }

  const needsDetail = findFixturesNeedingDetail(MAX_MATCH_DETAILS_PER_RUN);
  console.log(`[scheduled-fetch] ${needsDetail.length} match(es) need detail this run (already-finished matches with stats are skipped, and future matches that haven't kicked off yet are excluded — nothing to fetch until they start)`);
  await fetchMatchDetailsForList(needsDetail, base, 'scheduled-fetch', null);

  console.log('[scheduled-fetch] Run complete.');
  scheduledFetchRunning = false;
}

const SCHEDULED_FETCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
setInterval(runScheduledFetch, SCHEDULED_FETCH_INTERVAL_MS);

// Manual, one-time "fetch everything now" — same underlying logic as the
// hourly job, just no cap. Genuinely takes hours for a large backlog
// (~1900 matches ≈ 2.5+ hours), so this returns immediately and runs in
// the background; check progress via /api/admin/full-catchup-status.
app.post('/api/admin/force-full-stats-catchup', async (req, res) => {
  if (scheduledFetchRunning) {
    return res.status(409).json({ error: 'A fetch is already running (either the hourly job or a previous catch-up) — try again once it finishes.' });
  }
  const needsDetail = findFixturesNeedingDetail(100000); // effectively uncapped
  if (needsDetail.length === 0) {
    return res.json({ started: false, reason: 'Nothing to fetch — every stored match already has stats.' });
  }

  scheduledFetchRunning = true;
  fullCatchupProgress = { running: true, totalToFetch: needsDetail.length, totalDone: 0, startedAt: new Date().toISOString(), lastUpdate: new Date().toISOString() };
  const base = `http://localhost:${PORT}`;
  console.log(`[full-catchup] Starting — ${needsDetail.length} matches to fetch, expect ~${Math.round(needsDetail.length * 4.8 / 60)} minutes.`);

  fetchMatchDetailsForList(needsDetail, base, 'full-catchup', fullCatchupProgress).then(() => {
    console.log('[full-catchup] Complete.');
    fullCatchupProgress.running = false;
    scheduledFetchRunning = false;
  });

  res.json({ started: true, totalToFetch: needsDetail.length, estimatedMinutes: Math.round(needsDetail.length * 4.8 / 60) });
});

app.get('/api/admin/full-catchup-status', (req, res) => {
  res.json(fullCatchupProgress);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sportscheck backend running on port ${PORT}`);
  console.log('Hourly scheduled fetch active — first run in 15s, then every hour.');
  setTimeout(runScheduledFetch, 15000); // give the server a moment to fully initialize first
});
