// SQLite database — stores everything fetched from API-Sports so the
// frontend never has to wait on (or pay for) a live API call on every visit.
// The file lives at data/matchday.db and is created automatically on first run.
//
// Uses node:sqlite, Node's built-in SQLite module (stable as of Node 22.5+ /
// fully stable on Node 26+, which is what Render is running). No native
// compilation, no node-gyp, no prebuilt-binary problems — it ships inside
// Node itself. This replaced better-sqlite3 after that package failed to
// build against a newer Node version's V8 API on first deploy.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'matchday.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS standings (
    league TEXT NOT NULL,
    season TEXT NOT NULL,
    position INTEGER,
    team TEXT,
    played INTEGER,
    won INTEGER,
    drawn INTEGER,
    lost INTEGER,
    goals_for INTEGER,
    goals_against INTEGER,
    points INTEGER,
    updated_at TEXT,
    PRIMARY KEY (league, season, team)
  );

  CREATE TABLE IF NOT EXISTS scorers (
    league TEXT NOT NULL,
    season TEXT NOT NULL,
    rank INTEGER,
    player TEXT,
    team TEXT,
    goals INTEGER,
    assists INTEGER,
    nationality TEXT,
    position_name TEXT,
    updated_at TEXT,
    PRIMARY KEY (league, season, player, team)
  );

  CREATE TABLE IF NOT EXISTS fixtures (
    fixture_id TEXT PRIMARY KEY,
    league TEXT,
    season TEXT,
    kickoff_utc TEXT,
    home_team TEXT,
    away_team TEXT,
    venue TEXT,
    status TEXT,
    home_score INTEGER,
    away_score INTEGER,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS injuries (
    team TEXT,
    player TEXT,
    issue TEXT,
    status TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS lineups (
    fixture_id TEXT,
    team TEXT,
    formation TEXT,
    players_json TEXT,
    confirmed INTEGER,
    updated_at TEXT,
    PRIMARY KEY (fixture_id, team)
  );

  CREATE TABLE IF NOT EXISTS h2h (
    team_a TEXT,
    team_b TEXT,
    fixture_id TEXT,
    date TEXT,
    home_team TEXT,
    away_team TEXT,
    home_score INTEGER,
    away_score INTEGER,
    competition TEXT,
    updated_at TEXT,
    PRIMARY KEY (team_a, team_b, fixture_id)
  );

  -- Stats (shots/possession/xG/etc, a flat list) and incidents (goals/cards/
  -- subs) for a specific match, from the scraper. Stored as JSON since the
  -- shape is a variable-length list, not a fixed set of columns — matches
  -- how Flashscore's own stats feed self-describes each row rather than
  -- using a hardcoded schema.
  CREATE TABLE IF NOT EXISTS match_detail (
    fixture_id TEXT PRIMARY KEY,
    core_json TEXT,
    stats_json TEXT,
    incidents_json TEXT,
    updated_at TEXT
  );

  -- Cached Claude API output for the AI and News tabs, so re-opening the same
  -- match doesn't burn another API call. Cleared/refreshed on a set interval.
  CREATE TABLE IF NOT EXISTS ai_cache (
    fixture_id TEXT NOT NULL,
    kind TEXT NOT NULL,       -- 'ai' or 'news'
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (fixture_id, kind)
  );
`);

module.exports = db;
