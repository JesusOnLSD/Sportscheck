#!/usr/bin/env python3
"""
Fetches full match stats for a specific list of fixture IDs — used to
backfill stats for one team's historical matches, on demand, only when
that team's General/Opponent stats actually get opened. Not run for
every match up front; only when actually needed.

Fixture IDs are read from stdin as a JSON array, not passed as command-
line arguments — a team's match list can run to 60-80+ fixtures across
a few seasons, safely past what's comfortable to pass as argv.

Only fetches the stats themselves (not core status, lineups, or
incidents) — that's all Season/General/Opponent stats actually need,
about a quarter of the requests fetch_match_detail.py would use per
match, since this is meant to run across dozens of matches at once.

Runs as a background process (same pattern as fetch_history.py), pushing
results back to Node's own server on localhost as it goes.
"""

import sys
import os
import json
import time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flashscore_scraper.match_detail import get_match_stats  # noqa: E402
from flashscore_scraper.sports import SPORT_IDS  # noqa: E402
from rate_limiter import wait_for_rate_limit  # noqa: E402

PRINT_EVERY_N_MATCHES = 5


def push(base_url, fixture_id, stats):
    try:
        resp = requests.post(
            f"{base_url}/api/admin/ingest-team-stats",
            json={"fixtureId": fixture_id, "stats": stats},
            timeout=30,
        )
        return resp.status_code == 200
    except Exception as e:
        print(f"    push failed for {fixture_id}: {e}", flush=True)
        return False


def main():
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
    raw_input = sys.stdin.read()
    fixture_ids = json.loads(raw_input)

    print(f"Fetching stats for {len(fixture_ids)} matches, base URL {base_url}", flush=True)
    sport_id = SPORT_IDS["soccer"]
    start = time.time()
    succeeded = 0

    for i, fixture_id in enumerate(fixture_ids):
        wait_for_rate_limit()
        try:
            stats = get_match_stats(sport_id, fixture_id)
        except Exception as e:
            print(f"    fetch failed for {fixture_id}: {e}", flush=True)
            continue

        if stats and push(base_url, fixture_id, stats):
            succeeded += 1

        if i % PRINT_EVERY_N_MATCHES == 0:
            elapsed = time.time() - start
            print(f"  {i}/{len(fixture_ids)} matches processed, {succeeded} stored so far — {elapsed:.0f}s elapsed", flush=True)

    elapsed = time.time() - start
    print(f"\nTeam stats backfill complete — {succeeded}/{len(fixture_ids)} matches stored, {elapsed:.0f}s total.", flush=True)


if __name__ == "__main__":
    main()
