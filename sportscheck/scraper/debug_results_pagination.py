#!/usr/bin/env python3
"""
Diagnostic only — we've confirmed the historical results feed pattern
(tr_1_198_<activeTournament>_<N>_1_2_en_1) works, and that
"activeTournament" (dYlOSQOD for 2023-24) is discoverable from the same
page resolve_tournament_ids() already fetches. The one remaining unknown
is what "<N>" actually means — a real capture only showed us N=183 from
a "Show more" click partway through browsing. Rather than guess, this
tries several plausible values directly against the live feed and
reports what each one actually returns, so the real pattern can be seen
rather than assumed.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    active_tournament = sys.argv[1] if len(sys.argv) > 1 else "dYlOSQOD"
    country_code = sys.argv[2] if len(sys.argv) > 2 else "198"

    from flashscore_scraper.feed_client import fetch_feed
    from rate_limiter import wait_for_rate_limit

    candidates = [0, 1, 20, 50, 100, 183, 200, 300, 380]
    results = []

    for n in candidates:
        feed_code = f"tr_1_{country_code}_{active_tournament}_{n}_1_2_en_1"
        wait_for_rate_limit()
        resp = fetch_feed(feed_code)
        results.append({
            "n": n,
            "feedCode": feed_code,
            "status": resp.status_code,
            "length": len(resp.text),
            "first200Chars": resp.text[:200],
            "matchCount": resp.text.count("~AA÷"),  # each match record starts with this marker
        })

    print(json.dumps({"success": True, "results": results}))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
