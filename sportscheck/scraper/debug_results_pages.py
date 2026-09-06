#!/usr/bin/env python3
"""
Diagnostic only — the embedded results block on a season page caps at
roughly 110 matches, not the full 380, so we only get each season's most
recent chunk. The page also loads more via:

    tr_1_<country>_<activeTournament>_<seasonId>_<N>_2_en_1

confirmed returning 102 matches for 2023-24 (seasonId 183). The "<N>"
position is the only unknown -- it may be a page number, in which case
incrementing it walks the whole season. This tries several values and
reports what each returns, including whether the matches differ between
pages (same count but identical matches would mean it is NOT pagination).
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    active_tournament = sys.argv[1] if len(sys.argv) > 1 else "dYlOSQOD"
    season_id = sys.argv[2] if len(sys.argv) > 2 else "183"
    country_code = sys.argv[3] if len(sys.argv) > 3 else "198"

    from flashscore_scraper.feed_client import fetch_feed
    from flashscore_scraper.fixtures import parse_fixtures_text
    from rate_limiter import wait_for_rate_limit

    results = []
    seen_first_ids = {}

    for page in [1, 2, 3, 4]:
        feed_code = f"tr_1_{country_code}_{active_tournament}_{season_id}_{page}_2_en_1"
        wait_for_rate_limit()
        resp = fetch_feed(feed_code)

        matches = []
        if resp.text.strip():
            try:
                matches = parse_fixtures_text(resp.text, "soccer")
            except Exception as parse_err:
                matches = []

        pl_matches = [
            m for m in matches
            if m.tournament_name == "Premier League" and m.country == "England"
        ]

        first_id = pl_matches[0].match_id if pl_matches else None
        last_id = pl_matches[-1].match_id if pl_matches else None
        first_date = pl_matches[0].kickoff_utc if pl_matches else None
        last_date = pl_matches[-1].kickoff_utc if pl_matches else None

        seen_first_ids[page] = first_id

        results.append({
            "page": page,
            "feedCode": feed_code,
            "status": resp.status_code,
            "length": len(resp.text),
            "totalParsed": len(matches),
            "premierLeagueCount": len(pl_matches),
            "firstMatchId": first_id,
            "firstMatchDate": first_date,
            "lastMatchId": last_id,
            "lastMatchDate": last_date,
        })

    # If pages return different first-match IDs, this really is pagination.
    distinct = len({v for v in seen_first_ids.values() if v})
    print(json.dumps({
        "success": True,
        "isPagination": distinct > 1,
        "distinctFirstMatches": distinct,
        "results": results,
    }))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
