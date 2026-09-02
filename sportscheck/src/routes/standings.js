const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/standings?league=Premier%20League&season=2026
router.get('/', (req, res) => {
  const league = req.query.league || 'Premier League';
  const season = req.query.season || '2026';

  const rows = db
    .prepare(
      `SELECT position, team, played, won, drawn, lost, goals_for AS goalsFor,
              goals_against AS goalsAgainst, points, updated_at AS updatedAt
       FROM standings WHERE league = ? AND season = ? ORDER BY position ASC`
    )
    .all(league, season);

  if (rows.length === 0) {
    return res.json({ league, season, loaded: false, standings: [] });
  }
  res.json({ league, season, loaded: true, updatedAt: rows[0].updatedAt, standings: rows });
});

module.exports = router;
