#!/usr/bin/env python3
"""
Diagnostic only — not part of the normal pipeline. Tests two candidate
feed codes side by side (stageId-based and tournamentId-based) so a
mismatch can be diagnosed directly rather than guessed at one at a time.
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
    resp_stage = fetch_feed(f"df_tt_1_{stage_id}")

    wait_for_rate_limit()
    resp_tournament = fetch_feed(f"df_tt_1_{tournament_id}")

    result = {
        "success": True,
        "tournamentId": tournament_id,
        "stageId": stage_id,
        "stageIdAttempt": {
            "feedCode": f"df_tt_1_{stage_id}",
            "status": resp_stage.status_code,
            "length": len(resp_stage.text),
            "first500Chars": resp_stage.text[:500],
            "containsUAMarker": "UA÷" in resp_stage.text,
        },
        "tournamentIdAttempt": {
            "feedCode": f"df_tt_1_{tournament_id}",
            "status": resp_tournament.status_code,
            "length": len(resp_tournament.text),
            "first500Chars": resp_tournament.text[:500],
            "containsUAMarker": "UA÷" in resp_tournament.text,
        },
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
