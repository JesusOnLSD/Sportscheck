#!/usr/bin/env python3
"""
Diagnostic only — tests whether resolve_tournament_ids() (already proven
for the current season) also works for a specific past season, by
pointing it at that season's own competition slug
("premier-league-2023-2024") instead of the generic one
("premier-league"). If this resolves real IDs and the standings/scorers
feeds return real data, historical standings and historical top scorers
both become buildable using the exact same feed-code patterns already
proven for the current season — just a different (season-specific) ID
pair, discovered the same way, not a different mechanism.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from flashscore_scraper.standings import resolve_tournament_ids
    from flashscore_scraper.feed_client import fetch_feed
    from rate_limiter import wait_for_rate_limit

    season_label = sys.argv[1] if len(sys.argv) > 1 else "2023-2024"
    season_slug = f"premier-league-{season_label}"

    wait_for_rate_limit()
    tournament_id, stage_id = resolve_tournament_ids("england", season_slug, sport="football")

    wait_for_rate_limit()
    standings_resp = fetch_feed(f"to_{tournament_id}_{stage_id}_1")

    wait_for_rate_limit()
    scorers_resp = fetch_feed(f"tt_{tournament_id}_{stage_id}")

    result = {
        "success": True,
        "seasonLabel": season_label,
        "seasonSlug": season_slug,
        "tournamentId": tournament_id,
        "stageId": stage_id,
        "standingsAttempt": {
            "feedCode": f"to_{tournament_id}_{stage_id}_1",
            "status": standings_resp.status_code,
            "length": len(standings_resp.text),
            "first500Chars": standings_resp.text[:500],
        },
        "scorersAttempt": {
            "feedCode": f"tt_{tournament_id}_{stage_id}",
            "status": scorers_resp.status_code,
            "length": len(scorers_resp.text),
            "first500Chars": scorers_resp.text[:500],
        },
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
