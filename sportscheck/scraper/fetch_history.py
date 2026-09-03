#!/usr/bin/env python3
"""
Backfill: walks a range of days (both back AND forward from today,
matching a normal fixtures list — past results plus near-term scheduled
matches), collecting every Premier League match found — scores/dates
only, not full match stats. Full stats for a specific team's matches are
fetched separately, on demand, only when that team's General/Opponent
stats actually get opened.

Range is configurable via command-line args:
    python fetch_history.py <base_url> <days_back> <days_forward>

TESTING CONFIGURATION RIGHT NOW: defaults to ±4 weeks (28 days each way,
56 total) rather than the full 5 years, specifically so the whole
pipeline can be tested quickly without a 30-60 minute wait each time.
To restore the full 5-year historical range once everything else is
verified working, call with days_back=1825 days_forward=0 (or whatever
forward window makes sense) — nothing else about this script changes.

Rate-limited to 50/min (see rate_limiter.py), same as everything else.

Runs as a background process (spawned by Node without waiting for it),
pushing results back to Node's own server on localhost as it goes —
never leaves the machine, so no external secret is needed here.
"""

import sys
import os
import json
import time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flashscore_scraper.fixtures import get_fixtures  # noqa: E402
from rate_limiter import wait_for_rate_limit  # noqa: E402

DEFAULT_DAYS_BACK = 28   # TESTING: ±4 weeks for now, not the full 5 years
DEFAULT_DAYS_FORWARD = 28
PRINT_EVERY_N_DAYS = 10
BATCH_SIZE = 50


def push(base_url, matches):
    games = [
        {
            "fixtureId": m.match_id,
            "kickoffUtc": m.kickoff_utc,
            "homeTeam": m.home_team,
            "awayTeam": m.away_team,
            "status": m.status,
            "homeScore": m.home_score,
            "awayScore": m.away_score,
        }
        for m in matches
    ]
    try:
        resp = requests.post(
            f"{base_url}/api/admin/ingest-history-fixtures",
            json={"league": "Premier League", "games": games},
            timeout=30,
        )
        print(f"    pushed {len(games)} matches -> HTTP {resp.status_code}", flush=True)
    except Exception as e:
        print(f"    push failed: {e}", flush=True)


def main():
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DAYS_BACK
    days_forward = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_DAYS_FORWARD
    total_days = days_back + days_forward + 1

    print(f"Starting backfill: {days_back} days back, {days_forward} days forward, base URL {base_url}", flush=True)
    batch = []
    total_found = 0
    start = time.time()

    offsets = list(range(days_forward, -days_back - 1, -1))  # forward first, then today, then backward
    for i, offset in enumerate(offsets):
        wait_for_rate_limit()
        day = get_fixtures("soccer", day_offset=offset)
        matches = [
            m for m in day
            if m.tournament_name == "Premier League" and m.country == "England"
            and m.status in ("finished", "scheduled")
        ]
        batch.extend(matches)

        if i % PRINT_EVERY_N_DAYS == 0:
            elapsed = time.time() - start
            print(f"  Day {i}/{total_days} (offset {offset}) — {total_found + len(batch)} matches found so far — {elapsed:.0f}s elapsed", flush=True)

        if len(batch) >= BATCH_SIZE:
            push(base_url, batch)
            total_found += len(batch)
            batch = []

    if batch:
        push(base_url, batch)
        total_found += len(batch)

    elapsed = time.time() - start
    print(f"\nBackfill complete — {total_found} Premier League matches found, {elapsed:.0f}s total.", flush=True)


if __name__ == "__main__":
    main()
