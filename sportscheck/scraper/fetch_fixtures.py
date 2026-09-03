#!/usr/bin/env python3
"""
Fetches Premier League fixtures for a window of days around today and
prints the result as JSON.

WEEKS_BACK/WEEKS_FORWARD are deliberately small (1 week each) — this
route runs SYNCHRONOUSLY (the frontend awaits it for an immediate count
and list refresh), and Node's exec timeout for synchronous calls is 60
seconds. At 1.2s minimum per rate-limited request, 1 week each way is 15
day-checks (~18s), comfortably under that ceiling with real margin.

The wider ±4 week view comes from start-history-backfill instead, which
runs as a background process specifically because it doesn't fit under
that same 60-second ceiling — 4 weeks each way is 57 day-checks, whose
rate-limited pacing alone (68.4s) already exceeds 60s before any actual
network time on top. Same underlying data, this one's just the fast
synchronous slice for quick feedback; the wider historical view isn't
time-boxed the same way since it's never awaited.

Same contract as fetch_standings.py: always valid JSON on stdout, success
or failure, never a raw traceback.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

WEEKS_BACK = 1
WEEKS_FORWARD = 1

try:
    from flashscore_scraper.fixtures import get_fixtures
    from rate_limiter import wait_for_rate_limit

    all_matches = []
    for offset in range(-WEEKS_BACK * 7, WEEKS_FORWARD * 7 + 1):
        wait_for_rate_limit()
        day = get_fixtures("soccer", day_offset=offset)
        # Several countries have a top-flight league also called "Premier
        # League" in English (Ukraine, Wales, and others) — filtering by
        # tournament_name alone would silently mix them in. country is
        # checked too, matching the naming convention seen elsewhere in
        # this scraper's real data ("England", "Angola", "Argentina" —
        # full names, not codes).
        pl = [m for m in day if m.tournament_name == "Premier League" and m.country == "England"]
        all_matches.extend(pl)

    result = {
        "success": True,
        "fixtures": [
            {
                "fixtureId": m.match_id,
                "kickoffUtc": m.kickoff_utc,
                "homeTeam": m.home_team,
                "awayTeam": m.away_team,
                "status": m.status,
                "homeScore": m.home_score,
                "awayScore": m.away_score,
            }
            for m in all_matches
        ],
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
