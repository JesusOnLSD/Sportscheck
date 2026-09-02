#!/usr/bin/env python3
"""
Fetches Premier League top scorers (current season) from Flashscore and
prints the result as JSON to stdout. Same contract as the other fetch_*
scripts: always valid JSON, success or failure, never a raw traceback.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flashscore_scraper.scorers import get_top_scorers
    from rate_limiter import wait_for_rate_limit

    wait_for_rate_limit()
    rows = get_top_scorers("england", "premier-league", sport="football")

    result = {
        "success": True,
        "scorers": [
            {
                "rank": r.rank,
                "player": r.player,
                "team": r.team,
                "goals": r.goals,
                "assists": r.assists,
                "nationality": r.nationality,
                "position": r.position,
            }
            for r in rows
        ],
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
