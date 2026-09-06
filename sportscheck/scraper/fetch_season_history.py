#!/usr/bin/env python3
"""
Backfills real historical fixtures by season, replacing the day-offset
approach that silently returned nothing past ~1 year back.

Run in the background (it fetches one page per season, rate-limited):
    python fetch_season_history.py <ingest_url> [num_seasons]

Pushes to the backend after EVERY season rather than batching at the
end, so an interrupted run keeps everything already fetched -- the same
resilience lesson learned from the original history backfill.

Prints progress to stdout for pm2 logs, and a final JSON summary line.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEFAULT_NUM_SEASONS = 6  # current + 5 back, matching the 5-year stats window


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "ingest URL argument is required"}))
        return 1

    ingest_url = sys.argv[1]
    num_seasons = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_NUM_SEASONS

    import requests
    from flashscore_scraper.historical_results import (
        get_available_seasons,
        get_historical_results,
        season_label_from_name,
    )
    from rate_limiter import wait_for_rate_limit

    print(f"[season-history] Discovering available seasons...", flush=True)
    wait_for_rate_limit()
    try:
        seasons = get_available_seasons()
    except Exception as err:
        print(json.dumps({"success": False, "error": f"could not list seasons: {err}"}))
        return 1

    # Seasons come newest-first; take the most recent N that parse as
    # normal two-year season names (skips odd historical entries).
    selected = []
    for season in seasons:
        label = season_label_from_name(season["name"])
        if label is None:
            continue
        selected.append((season["name"], label))
        if len(selected) >= num_seasons:
            break

    print(f"[season-history] Will fetch {len(selected)} season(s): "
          f"{', '.join(name for name, _ in selected)}", flush=True)

    total_pushed = 0
    seasons_done = 0
    failures = []

    for season_name, season_label in selected:
        print(f"[season-history] Fetching {season_name}...", flush=True)
        try:
            wait_for_rate_limit()
            matches = get_historical_results(season_label)
        except Exception as err:
            print(f"[season-history]   FAILED {season_name}: {err}", flush=True)
            failures.append({"season": season_name, "error": str(err)})
            continue

        # Keep only the competition we actually want -- a results page can
        # include other competitions' blocks, and tournament name alone
        # isn't enough (Ukraine and Wales also have a "Premier League").
        relevant = [
            m for m in matches
            if m.tournament_name == "Premier League" and m.country == "England"
        ]
        print(f"[season-history]   {len(relevant)} Premier League match(es) found", flush=True)

        if not relevant:
            seasons_done += 1
            continue

        games = [{
            "fixtureId": m.match_id,
            "kickoffUtc": m.kickoff_utc,
            "homeTeam": m.home_team,
            "awayTeam": m.away_team,
            "status": m.status,
            "homeScore": m.home_score,
            "awayScore": m.away_score,
        } for m in relevant]

        # Push per season, not at the end -- an interrupted run keeps
        # whatever seasons already completed.
        try:
            response = requests.post(
                ingest_url,
                json={"league": "Premier League", "games": games},
                timeout=60,
            )
            response.raise_for_status()
            stored = response.json().get("stored", 0)
            total_pushed += stored
            print(f"[season-history]   stored {stored} (running total {total_pushed})", flush=True)
        except Exception as err:
            print(f"[season-history]   PUSH FAILED for {season_name}: {err}", flush=True)
            failures.append({"season": season_name, "error": f"push failed: {err}"})
            continue

        seasons_done += 1

    print(json.dumps({
        "success": True,
        "seasonsRequested": len(selected),
        "seasonsCompleted": seasons_done,
        "totalPushed": total_pushed,
        "failures": failures,
    }), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
