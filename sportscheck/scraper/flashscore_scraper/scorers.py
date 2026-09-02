"""
Top scorers for a competition.

Reuses standings.py's resolve_tournament_ids() to get the (tournamentId,
tournamentStageId) pair — that lookup is already proven working, this
module doesn't repeat it. The feed itself is a different code:

    df_tt_1_<tournamentStageId>

Best-reasoned guess based on a real captured example (df_tt_1_CIuslOyP),
not independently confirmed the way the parser below is — parser was
tested directly against that real response and correctly extracts every
field. If the ID guess turns out wrong, this returns an empty list
(a clear, honest "nothing found") rather than wrong data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .standings import resolve_tournament_ids
from .feed_client import fetch_feed


@dataclass
class ScorerRow:
    rank: int
    player: str
    team: str
    goals: int
    assists: int
    nationality: str
    position: str


def parse_top_scorers_text(text: str) -> List[ScorerRow]:
    """
    Parses Flashscore's top-scorers feed format: records separated by ~,
    fields within a record separated by ¬, each field a key÷value pair.
    Same delimiter convention as the rest of this scraper's feeds.
    """
    rows: List[ScorerRow] = []
    for part in text.split("~"):
        if "UA÷" not in part:
            continue  # header/meta segment, not a player record
        fields = {}
        for kv in part.split("¬"):
            if "÷" in kv:
                k, v = kv.split("÷", 1)
                fields[k] = v
        if "UA" not in fields or "UF" not in fields:
            continue
        try:
            rank = int(fields.get("UA", 0))
        except ValueError:
            continue
        rows.append(
            ScorerRow(
                rank=rank,
                player=fields.get("UF", ""),
                team=fields.get("UU", ""),
                goals=int(fields.get("UJ", 0) or 0),
                assists=int(fields.get("UK", 0) or 0),
                nationality=fields.get("UCN", ""),
                position=fields.get("UPN", ""),
            )
        )
    return rows


def get_top_scorers(country_slug: str, league_slug: str, sport: str = "football", *, session=None) -> List[ScorerRow]:
    _tournament_id, stage_id = resolve_tournament_ids(country_slug, league_slug, sport, session=session)
    resp = fetch_feed(f"df_tt_1_{stage_id}", session=session)
    return parse_top_scorers_text(resp.text)
