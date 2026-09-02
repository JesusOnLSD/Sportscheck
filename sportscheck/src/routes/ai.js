const express = require('express');
const db = require('../db');
const { generateAIAnalysis } = require('../services/claude');

const router = express.Router();

// POST /api/ai/:fixtureId — this is what the "Load AI response" button calls.
// Checks the cache first so re-opening the same match doesn't burn another
// API call; pass ?force=true to regenerate anyway.
router.post('/:fixtureId', async (req, res) => {
  const { fixtureId } = req.params;
  const force = req.query.force === 'true';

  if (!force) {
    const cached = db
      .prepare(`SELECT content_json AS content, created_at AS createdAt FROM ai_cache WHERE fixture_id = ? AND kind = 'ai'`)
      .get(fixtureId);
    if (cached) {
      return res.json({ ...JSON.parse(cached.content), cached: true, createdAt: cached.createdAt });
    }
  }

  const fixture = db.prepare(`SELECT * FROM fixtures WHERE fixture_id = ?`).get(fixtureId);
  if (!fixture) return res.status(404).json({ error: 'Unknown fixture — load its data first.' });

  const injuries = db.prepare(`SELECT team, player, issue FROM injuries WHERE team IN (?, ?)`).all(fixture.home_team, fixture.away_team);
  const standings = db
    .prepare(`SELECT team, position, played, won, drawn, lost, points FROM standings WHERE team IN (?, ?)`)
    .all(fixture.home_team, fixture.away_team);
  const h2h = db
    .prepare(`SELECT date, home_team, away_team, home_score, away_score FROM h2h WHERE team_a IN (?, ?) LIMIT 10`)
    .all(fixture.home_team, fixture.away_team);

  const context = {
    homeTeam: fixture.home_team,
    awayTeam: fixture.away_team,
    venue: fixture.venue,
    kickoff: fixture.kickoff_utc,
    standings,
    injuries,
    recentMeetings: h2h
  };

  const result = await generateAIAnalysis(context);
  if (result.error) return res.status(502).json(result);

  db.prepare(
    `INSERT INTO ai_cache (fixture_id, kind, content_json, created_at) VALUES (?, 'ai', ?, ?)
     ON CONFLICT(fixture_id, kind) DO UPDATE SET content_json = excluded.content_json, created_at = excluded.created_at`
  ).run(fixtureId, JSON.stringify(result), new Date().toISOString());

  res.json({ ...result, cached: false });
});

module.exports = router;
