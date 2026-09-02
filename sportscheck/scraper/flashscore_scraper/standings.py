"""
League standings / tables.

Unlike fixtures and match detail, standings aren't keyed by a simple ID
you already have -- they're keyed by a "tournament ID" + "tournament
stage ID" pair that's specific to one competition's one season. Flashscore
embeds those two IDs directly in the plain HTML of a competition's
standings page, e.g.:

    https://www.flashscore.com/football/england/premier-league/standings/

...contains a `<script>` block with:

    window.leaguePageHeaderData = {
        tournamentId: "SY30SsKF",
        tournamentStageId: "CfoA8Dmm",
        ...
    }

So this module first does a plain GET of that HTML page (no special
auth header needed -- it's just the normal web page) to read those two
IDs, then calls the feed `to_<tournamentId>_<tournamentStageId>_1` to
get the actual table.

You identify a competition the same way you'd browse to it on
flashscore.com: <country-slug>/<competition-slug>, e.g.
"england/premier-league", "spain/laliga", "europe/champions-league".
If you're not sure of the slug, visit the competition on
flashscore.com and copy it from the URL.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional

from . import parser
from .feed_client import FlashscoreError, fetch_feed, fetch_url_text

BASE_URL = "https://www.flashscore.com/football"

_TOURNAMENT_ID_RE = re.compile(r'tournamentId:\s*"([^"]+)"')
_STAGE_ID_RE = re.compile(r'tournamentStageId:\s*"([^"]+)"')


@dataclass
class StandingsRow:
    rank: Optional[int]
    team: str
    team_id: str
    played: Optional[int]
    wins: Optional[int]
    draws: Optional[int]
    losses: Optional[int]
    goals_for: Optional[int]
    goals_against: Optional[int]
    points: Optional[int]
    raw: dict


def resolve_tournament_ids(country_slug: str, league_slug: str, sport: str = "football", *, session=None) -> tuple:
    """
    Look up (tournamentId, tournamentStageId) for a competition by fetching its
    standings page HTML. Raises FlashscoreError with a clear message if the
    page doesn't contain what we expect (e.g. wrong slug, or Flashscore changed
    how the page embeds this).
    """
    url = f"https://www.flashscore.com/{sport}/{country_slug}/{league_slug}/standings/"
    html = fetch_url_text(url, session=session)

    tid_match = _TOURNAMENT_ID_RE.search(html)
    stage_match = _STAGE_ID_RE.search(html)
    if not tid_match or not stage_match:
        raise FlashscoreError(
            f"Couldn't find tournament IDs on {url}. Either the slug "
            f"'{country_slug}/{league_slug}' is wrong (open the URL in a "
            "browser to check), or this competition doesn't have a standings "
            "page (e.g. some cup competitions), or Flashscore changed how "
            "the page embeds this data."
        )
    return tid_match.group(1), stage_match.group(1)


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def parse_standings_text(text: str) -> List[StandingsRow]:
    rows: List[StandingsRow] = []
    for record in parser.parse_records(text):
        d = parser.to_dict(record)
        if "TR" not in d:
            continue  # logos / headers / "last 3 matches" sub-records -- not a table row

        goals_for = goals_against = None
        if d.get("TG") and ":" in d["TG"]:
            gf, ga = d["TG"].split(":", 1)
            goals_for, goals_against = _int(gf), _int(ga)

        rows.append(
            StandingsRow(
                rank=_int(d.get("TR")),
                team=d.get("TN", ""),
                team_id=d.get("TI", ""),
                played=_int(d.get("TM")),
                wins=_int(d.get("TW")),
                draws=_int(d.get("TDR")),
                losses=_int(d.get("TL")),
                goals_for=goals_for,
                goals_against=goals_against,
                points=_int(d.get("TP")),
                raw=d,
            )
        )
    return rows


def get_standings(country_slug: str, league_slug: str, sport: str = "football", *, session=None) -> List[StandingsRow]:
    tournament_id, stage_id = resolve_tournament_ids(country_slug, league_slug, sport, session=session)
    resp = fetch_feed(f"to_{tournament_id}_{stage_id}_1", session=session)
    return parse_standings_text(resp.text)
