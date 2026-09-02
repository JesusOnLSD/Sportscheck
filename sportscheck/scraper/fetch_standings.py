#!/usr/bin/env python3
"""
Single-purpose script: fetch Premier League standings from Flashscore and
print the result as JSON to stdout. Nothing else — no HTTP calls, no
server, no other leagues. Designed to be spawned by Node as a subprocess:
run it, read stdout, done.

Errors also come out as valid JSON ({"success": false, "error": "..."})
rather than a raw Python traceback, so the calling Node code never has to
guess whether stdout is real data or a crash — it's always parseable.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flashscore_scraper.standings import get_standings

    rows = get_standings("england", "premier-league", sport="football")

    result = {
        "success": True,
        "standings": [
            {
                "position": r.rank,
                "team": r.team,
                "played": r.played,
                "won": r.wins,
                "drawn": r.draws,
                "lost": r.losses,
                "goalsFor": r.goals_for,
                "goalsAgainst": r.goals_against,
                "points": r.points,
            }
            for r in rows
        ],
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
