#!/usr/bin/env python3
"""
Diagnostic only — not part of the normal pipeline. Shows exactly what
resolve_tournament_ids() and the scorers feed actually return right now,
raw and untouched by the parser, so a "0 scorers" result can be diagnosed
instead of guessed at.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flashscore_scraper.standings import resolve_tournament_ids
    from flashscore_scraper.feed_client import fetch_feed
    from rate_limiter import wait_for_rate_limit

    wait_for_rate_limit()
    tournament_id, stage_id = resolve_tournament_ids("england", "premier-league", sport="football")

    wait_for_rate_limit()
    resp = fetch_feed(f"df_tt_1_{stage_id}")

    result = {
        "success": True,
        "tournamentId": tournament_id,
        "stageId": stage_id,
        "feedCode": f"df_tt_1_{stage_id}",
        "rawResponseStatus": resp.status_code,
        "rawResponseLength": len(resp.text),
        "rawResponseFirst2000Chars": resp.text[:2000],
        "containsUAMarker": "UA÷" in resp.text,
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
