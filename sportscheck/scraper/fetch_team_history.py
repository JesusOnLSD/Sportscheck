#!/usr/bin/env python3
"""
Backfills one specific team's match history (fixtures + full match stats)
for a window of days around today, and prints the result as JSON.

WEEKS_BACK/WEEKS_FORWARD are deliberately small (4 weeks) for now — same
reasoning as fetch_fixtures.py: without a persistent disk, everything
gets wiped on restart, so there's no point fetching further than what's
useful during testing. Bump these up once running somewhere with real
persistent storage.

This is the expensive one: for each day in the window (57 days), one
call to find fixtures, then one more call per match actually involving
this team to get its full stats. Rate-limited throughout (see
rate_limiter.py) — expect this to take a few minutes, not seconds.

Takes the team name as a command-line argument:
    python3 fetch_team_history.py "Arsenal"

Same contract as the other fetch_* scripts: always valid JSON on stdout,
success or failure, never a raw traceback.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

WEEKS_BACK = 4
WEEKS_FORWARD = 4

try:
    if len(sys.argv) < 2:
        raise ValueError("team name argument is required")
    team_name = sys.argv[1]

    from flashscore_scraper.fixtures import get_fixtures
    from flashscore_scraper.match_detail import get_match_core, get_match_summary, get_match_stats, get_match_lineups
    from flashscore_scraper.sports import SPORT_IDS
    from rate_limiter import wait_for_rate_limit

    sport_id = SPORT_IDS["soccer"]
    team_matches = []

    for offset in range(-WEEKS_BACK * 7, WEEKS_FORWARD * 7 + 1):
        wait_for_rate_limit()
        day = get_fixtures("soccer", day_offset=offset)
        pl_today = [m for m in day if m.tournament_name == "Premier League" and m.country == "England"]
        for m in pl_today:
            if m.home_team == team_name or m.away_team == team_name:
                team_matches.append(m)

    matches_out = []
    for m in team_matches:
        entry = {
            "fixtureId": m.match_id,
            "kickoffUtc": m.kickoff_utc,
            "homeTeam": m.home_team,
            "awayTeam": m.away_team,
            "status": m.status,
            "homeScore": m.home_score,
            "awayScore": m.away_score,
            "stats": [],
            "incidents": [],
        }
        if m.status == "finished":
            wait_for_rate_limit()
            stats = get_match_stats(sport_id, m.match_id)
            wait_for_rate_limit()
            summary = get_match_summary(sport_id, m.match_id)
            entry["stats"] = stats or []
            entry["incidents"] = summary.incidents if summary else []
        matches_out.append(entry)

    result = {"success": True, "team": team_name, "matches": matches_out}
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
