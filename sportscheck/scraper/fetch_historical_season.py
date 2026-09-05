#!/usr/bin/env python3
"""
Fetches standings and top scorers for a SPECIFIC past season, using the
exact same mechanism already proven for the current season —
resolve_tournament_ids() and the standings parser work unmodified here,
just pointed at that season's own competition slug
("premier-league-2023-2024") instead of the generic one. Confirmed
against a real captured 2023-24 response before this was built: the
existing parser correctly reproduced the real final table (Man City
champions on 91 points, Sheffield Utd relegated on 16).

Takes a season label as its one argument:
    python fetch_historical_season.py 2023-2024

Same contract as the other fetch_* scripts: always valid JSON on stdout,
success or failure, never a raw traceback.
"""

import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    if len(sys.argv) < 2:
        raise ValueError("season label argument is required, e.g. 2023-2024")
    season_label = sys.argv[1]
    season_slug = f"premier-league-{season_label}"

    from flashscore_scraper.standings import get_standings
    from flashscore_scraper.scorers import get_top_scorers
    from rate_limiter import wait_for_rate_limit

    wait_for_rate_limit()
    standings_rows = get_standings("england", season_slug, sport="football")

    wait_for_rate_limit()
    scorer_rows = get_top_scorers("england", season_slug, sport="football")

    result = {
        "success": True,
        "seasonLabel": season_label,
        "standings": [
            {
                "position": r.rank, "team": r.team, "played": r.played, "won": r.wins,
                "drawn": r.draws, "lost": r.losses, "goalsFor": r.goals_for,
                "goalsAgainst": r.goals_against, "points": r.points,
            }
            for r in standings_rows
        ],
        "scorers": [
            {
                "rank": r.rank, "player": r.player, "team": r.team, "goals": r.goals,
                "assists": r.assists, "nationality": r.nationality, "position": r.position,
            }
            for r in scorer_rows
        ],
    }
    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
    sys.exit(1)
