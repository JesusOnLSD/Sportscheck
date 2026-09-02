#!/usr/bin/env python3
"""
Fetches full match detail — core status, incidents (goals/cards/subs for
the timeline), stats (all 34 categories), and lineups — for one specific
fixture and prints the result as JSON.

Takes the fixture ID as a command-line argument:
    python3 fetch_match_detail.py <fixture_id>

Lineups come back home/away-keyed (not relabeled with real team names) —
the caller already has the real team names from the fixtures table and
does the relabeling, same division of responsibility as everything else
in this pipeline.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    if len(sys.argv) < 2:
        raise ValueError("fixture_id argument is required")
    fixture_id = sys.argv[1]

    from flashscore_scraper.match_detail import (
        get_match_core,
        get_match_summary,
        get_match_stats,
        get_match_lineups,
    )
    from flashscore_scraper.sports import SPORT_IDS
    from rate_limiter import wait_for_rate_limit

    sport_id = SPORT_IDS["soccer"]

    wait_for_rate_limit()
    core = get_match_core(sport_id, fixture_id)
    wait_for_rate_limit()
    summary = get_match_summary(sport_id, fixture_id)
    wait_for_rate_limit()
    stats = get_match_stats(sport_id, fixture_id)
    wait_for_rate_limit()
    raw_lineups = get_match_lineups(sport_id, fixture_id)

    result = {
        "success": True,
        "fixtureId": fixture_id,
        "core": core.__dict__ if core else None,
        "incidents": summary.incidents if summary else [],
        "stats": stats or [],
        "rawLineups": raw_lineups,
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
