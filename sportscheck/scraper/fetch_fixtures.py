#!/usr/bin/env python3
"""
Fetches Premier League fixtures for a window of days around today (3 days
back, 3 days forward — 7 days total) and prints the result as JSON.

A window rather than just "today" because most days have no Premier
League match at all — a single-day fetch would show nothing on most
runs. Bounded and rate-limited (see rate_limiter.py) rather than an
unbounded scan.

Same contract as fetch_standings.py: always valid JSON on stdout, success
or failure, never a raw traceback.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flashscore_scraper.fixtures import get_fixtures
    from rate_limiter import wait_for_rate_limit

    all_matches = []
    for offset in range(-3, 4):
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
