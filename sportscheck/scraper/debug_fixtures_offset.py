#!/usr/bin/env python3
"""
Diagnostic only — the 5-year backfill ran its full 42-minute sweep
successfully (exit code 0) but found zero new matches across most of
that range. This tests whether Flashscore's day-offset fixtures feed
(get_fixtures) actually returns real data at a specific far-back offset,
or comes back genuinely empty — which would explain the backfill finding
nothing without erroring, since an empty result isn't a failure the
script would ever catch or report as one.

Reports ALL matches found for that day (any sport, any league) so we can
tell whether the feed is truly empty, or just missing Premier League
specifically.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    day_offset = int(sys.argv[1]) if len(sys.argv) > 1 else -700

    from flashscore_scraper.fixtures import get_fixtures
    from rate_limiter import wait_for_rate_limit

    wait_for_rate_limit()
    matches = get_fixtures("soccer", day_offset=day_offset)

    result = {
        "success": True,
        "dayOffset": day_offset,
        "totalMatchesAnySport": len(matches),
        "sampleMatches": [
            {
                "tournamentName": m.tournament_name,
                "country": m.country,
                "homeTeam": m.home_team,
                "awayTeam": m.away_team,
                "kickoffUtc": m.kickoff_utc,
                "status": m.status,
            }
            for m in matches[:10]
        ],
        "premierLeagueEnglandCount": len([m for m in matches if m.tournament_name == "Premier League" and m.country == "England"]),
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
