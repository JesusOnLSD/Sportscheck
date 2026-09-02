const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/scorers?league=Premier%20League&season=2026
router.get('/', (req, res) => {
  const league = req.query.league || 'Premier League';
  const season = req.query.season || '2026';

  const rows = db
    .prepare(
      `SELECT rank, player, team, goals, assists, nationality, position_name AS position, updated_at AS updatedAt
       FROM scorers WHERE league = ? AND season = ? ORDER BY rank ASC, goals DESC`
    )
    .all(league, season);

  if (rows.length === 0) {
    return res.json({ league, season, loaded: false, scorers: [] });
  }
  res.json({ league, season, loaded: true, updatedAt: rows[0].updatedAt, scorers: rows });
});

module.exports = router;
