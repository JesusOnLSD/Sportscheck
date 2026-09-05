#!/usr/bin/env python3
"""
Backfill: walks a range of days (both back AND forward from today,
matching a normal fixtures list — past results plus near-term scheduled
matches), collecting every Premier League match found — scores/dates
only, not full match stats. Full stats get fetched separately by the
hourly scheduled job in server.js, which checks its own "memory" first —
skipping any match already marked finished with stats already stored,
only fetching what's actually missing or could still change.

Range is configurable via command-line args:
    python fetch_history.py <base_url> <days_back> <days_forward>

Defaults to the full 5 years back now that this runs on the Pi's
persistent storage — a stalled or interrupted run no longer wipes
anything (unlike Render's ephemeral disk, which is why this was
deliberately kept small during earlier testing).

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

DEFAULT_DAYS_BACK = 1825  # 5 years — now running on persistent Pi storage, so a stalled or interrupted run no longer wipes anything (unlike Render's ephemeral disk)
DEFAULT_DAYS_FORWARD = 28  # no need for a 5-year FORWARD window — fixtures aren't scheduled that far ahead
PRINT_EVERY_N_DAYS = 10


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
        return resp.status_code == 200
    except Exception as e:
        print(f"    push failed: {e}", flush=True)
        return False


def main():
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DAYS_BACK
    days_forward = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_DAYS_FORWARD
    total_days = days_back + days_forward + 1

    print(f"Starting backfill: {days_back} days back, {days_forward} days forward, base URL {base_url}", flush=True)
    total_found = 0
    start = time.time()

    # Pushed after EVERY day that has matches, not batched up to a
    # threshold — a real run found matches for two matchdays, but a third
    # (further back) never got saved because the process was interrupted
    # before either a 50-match batch filled or the full scan finished, so
    # everything collected since the last push was lost. Per-day pushing
    # means an interruption anywhere loses at most one day's matches, not
    # up to 49.
    offsets = list(range(days_forward, -days_back - 1, -1))  # forward first, then today, then backward
    for i, offset in enumerate(offsets):
        wait_for_rate_limit()
        day = get_fixtures("soccer", day_offset=offset)
        matches = [
            m for m in day
            if m.tournament_name == "Premier League" and m.country == "England"
            and m.status in ("finished", "scheduled")
        ]

        if matches:
            if push(base_url, matches):
                total_found += len(matches)

        if i % PRINT_EVERY_N_DAYS == 0:
            elapsed = time.time() - start
            print(f"  Day {i}/{total_days} (offset {offset}) — {total_found} matches stored so far — {elapsed:.0f}s elapsed", flush=True)

    elapsed = time.time() - start
    print(f"\nBackfill complete — {total_found} Premier League matches found, {elapsed:.0f}s total.", flush=True)


if __name__ == "__main__":
    main()
