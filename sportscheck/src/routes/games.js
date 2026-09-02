const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/games?date=2026-08-31&league=Premier League
// Returns whatever fixtures are cached for that date. Empty list is a normal,
// honest result if nothing's been fetched for that date yet.
router.get('/', (req, res) => {
  const date = req.query.date;
  const league = req.query.league || 'Premier League';
  if (!date) return res.status(400).json({ error: 'date query param is required, e.g. ?date=2026-08-31' });

  const rows = db
    .prepare(
      `SELECT fixture_id AS fixtureId, kickoff_utc AS kickoffUtc, venue, status,
              home_team AS homeTeam, away_team AS awayTeam, home_score AS homeScore, away_score AS awayScore
       FROM fixtures WHERE league = ? AND date(kickoff_utc) = date(?)`
    )
    .all(league, date);

  res.json({ date, league, games: rows });
});

// GET /api/games/:fixtureId — everything needed for the analysis tabs, in one call.
router.get('/:fixtureId', (req, res) => {
  const { fixtureId } = req.params;

  const fixture = db
    .prepare(
      `SELECT fixture_id AS fixtureId, kickoff_utc AS kickoffUtc, venue, status,
              home_team AS homeTeam, away_team AS awayTeam, home_score AS homeScore, away_score AS awayScore
       FROM fixtures WHERE fixture_id = ?`
    )
    .get(fixtureId);

  if (!fixture) {
    return res.status(404).json({ error: 'No cached fixture with that ID yet.' });
  }

  const injuries = db
    .prepare(`SELECT team, player, issue, status FROM injuries WHERE team IN (?, ?)`)
    .all(fixture.homeTeam, fixture.awayTeam);

  const h2h = db
    .prepare(
      `SELECT date, home_team AS homeTeam, away_team AS awayTeam, home_score AS homeScore,
              away_score AS awayScore, competition
       FROM h2h WHERE (team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?)
       ORDER BY date DESC LIMIT 20`
    )
    .all(fixture.homeTeam, fixture.awayTeam, fixture.awayTeam, fixture.homeTeam);

  const lineups = db
    .prepare(`SELECT team, formation, players_json AS playersJson, confirmed FROM lineups WHERE fixture_id = ?`)
    .all(fixtureId);

  res.json({ fixture, injuries, h2h, lineups: lineups.map((l) => ({ ...l, players: JSON.parse(l.playersJson || '[]') })) });
});

module.exports = router;
