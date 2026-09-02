const express = require('express');
const db = require('../db');
const { generateNewsAndRumors } = require('../services/claude');

const router = express.Router();

// POST /api/news/:fixtureId — separate from /api/ai so you can turn this on
// independently later, same caching approach.
router.post('/:fixtureId', async (req, res) => {
  const { fixtureId } = req.params;
  const force = req.query.force === 'true';

  if (!force) {
    const cached = db
      .prepare(`SELECT content_json AS content, created_at AS createdAt FROM ai_cache WHERE fixture_id = ? AND kind = 'news'`)
      .get(fixtureId);
    if (cached) {
      return res.json({ ...JSON.parse(cached.content), cached: true, createdAt: cached.createdAt });
    }
  }

  const fixture = db.prepare(`SELECT * FROM fixtures WHERE fixture_id = ?`).get(fixtureId);
  let homeTeam, awayTeam, kickoff;
  if (fixture) {
    homeTeam = fixture.home_team;
    awayTeam = fixture.away_team;
    kickoff = fixture.kickoff_utc;
  } else if (req.query.home && req.query.away) {
    // Fallback for matchups not backed by a real fetched fixture yet — e.g.
    // NHL's example matchup, since there's no real 2026-27 schedule out.
    homeTeam = req.query.home;
    awayTeam = req.query.away;
    kickoff = req.query.date || new Date().toISOString();
  } else {
    return res.status(404).json({ error: 'Unknown fixture — load its data first, or call with ?home=X&away=Y.' });
  }

  const result = await generateNewsAndRumors(homeTeam, awayTeam, kickoff);
  if (result.error) return res.status(502).json(result);

  db.prepare(
    `INSERT INTO ai_cache (fixture_id, kind, content_json, created_at) VALUES (?, 'news', ?, ?)
     ON CONFLICT(fixture_id, kind) DO UPDATE SET content_json = excluded.content_json, created_at = excluded.created_at`
  ).run(fixtureId, JSON.stringify(result), new Date().toISOString());

  res.json({ ...result, cached: false });
});

module.exports = router;
