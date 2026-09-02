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

// The one real pipeline for this pass: spawn the scraper, get Premier
// League standings, store them. Everything else (other leagues, other
// sports, other data types) follows this exact same pattern later.
app.post('/api/admin/fetch-standings', async (req, res) => {
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

// Serve the frontend (the HTML/CSS/JS files) as static assets.
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sportscheck backend running on port ${PORT}`);
  console.log('No scraper or scheduler active yet — frontend-only pass. Database is present but empty.');
});
