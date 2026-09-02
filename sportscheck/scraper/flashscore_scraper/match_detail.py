"""
Per-match detail: current score/minute, incidents (goals/cards/subs),
full statistics (including xG and friends), and lineups.

All of these are fetched by match ID (the `match_id` / "AA" field you get
back from fixtures.get_fixtures()), using feed codes shaped like:

    dc_1_<matchId>      core match state (score breakdown, current minute, which
                         detail sections are available for this match)
    df_sui_1_<matchId>  summary: incidents timeline (goals, cards, subs) + referee/venue
    df_st_1_<matchId>   full statistics, self-describing (see below)
    df_li_1_<matchId>   lineups, formations, per-player ratings

The "1" in the middle of those codes is the sport ID (see sports.py) --
these examples are for soccer; pass a different sport_id for other sports.

Not every match has every section (e.g. lower-league matches often have
no detailed stats yet). When a feed is empty, these functions return an
empty list/dict rather than raising -- check `dc.available_sections` if
you want to know up front what's available for a given match (its
"DX" field lists short codes like "ST" for stats, "LI" for lineups,
"HH" for head-to-head, "LT" for standings, "LC" for live commentary).

The statistics feed (df_st_1) is unusual among these in that IT NAMES ITS
OWN FIELDS: each stat row includes both a human-readable label ("Expected
goals (xG)", "Ball possession", ...) and the two teams' values, grouped by
period ("Match" / "1st Half" / "2nd Half") and category ("Top stats",
"Shots", "Attack", "Passes", "Defense", "Goalkeeping"). That means this
parser doesn't need to hardcode a translation table of stat codes --
whatever stats Flashscore has for a given match/sport (xG, xA, xGOT,
duels won, ...) come through automatically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

from . import parser
from .feed_client import fetch_feed
from .fixtures import STATUS_MAP


def _iso(unix_ts: Optional[str]) -> Optional[str]:
    if not unix_ts:
        return None
    try:
        return datetime.fromtimestamp(int(unix_ts), tz=timezone.utc).isoformat()
    except (ValueError, OSError):
        return None


# ---------------------------------------------------------------- core ----

@dataclass
class MatchCore:
    match_id: str
    status: str
    status_raw: Optional[str]
    current_minute: Optional[int]
    kickoff_utc: Optional[str]
    kickoff_unix: Optional[int]
    available_sections: List[str]
    raw: dict = field(default_factory=dict, repr=False)


def get_match_core(sport_id: int, match_id: str, *, session=None) -> Optional[MatchCore]:
    resp = fetch_feed(f"dc_{sport_id}_{match_id}", session=session)
    records = parser.parse_records(resp.text)
    if not records:
        return None
    d = parser.to_dict(records[0])
    minute = d.get("DB")
    return MatchCore(
        match_id=match_id,
        status=STATUS_MAP.get(d.get("DA"), "unknown"),
        status_raw=d.get("DA"),
        # Best-effort: DB looked like the live match minute in every sample we
        # checked, but Flashscore doesn't label it explicitly, so treat this
        # as an approximation rather than a guaranteed-exact clock.
        current_minute=int(minute) if minute not in (None, "", "-1") else None,
        kickoff_utc=_iso(d.get("DC")),
        kickoff_unix=int(d["DC"]) if d.get("DC") else None,
        available_sections=[s for s in d.get("DX", "").split(",") if s],
        raw=d,
    )


# ------------------------------------------------------------ summary -----

def _parse_incident(record: parser.Record) -> dict:
    multi = parser.to_multidict(record)

    def first(key):
        vals = multi.get(key, [])
        return vals[0] if vals else None

    events = []
    names = multi.get("IF", [])
    urls = multi.get("IU", [])
    types = multi.get("IK", [])
    ids = multi.get("IM", [])
    comments = multi.get("ICT", [])
    n = max(len(names), len(types))
    for i in range(n):
        events.append(
            {
                "type": types[i] if i < len(types) else None,
                "player": names[i] if i < len(names) else None,
                "player_id": ids[i] if i < len(ids) else None,
                "player_url": urls[i] if i < len(urls) else None,
                "comment": comments[i] if i < len(comments) and comments[i] else None,
            }
        )

    side_code = first("IA")
    return {
        "incident_id": first("III"),
        "minute": first("IB"),
        "team": {"1": "home", "2": "away"}.get(side_code, side_code),
        "reason_code": first("IJ"),
        "reason": first("IL"),
        "events": events,
    }


@dataclass
class MatchSummary:
    match_id: str
    match_info: dict  # referee, venue, attendance, ... (whatever Flashscore provides)
    incidents: List[dict]


def get_match_summary(sport_id: int, match_id: str, *, session=None) -> MatchSummary:
    resp = fetch_feed(f"df_sui_{sport_id}_{match_id}", session=session)
    match_info: dict = {}
    incidents: List[dict] = []
    current_period = None

    for record in parser.parse_records(resp.text):
        keys = parser.record_keys(record)
        if "MIT" in keys:
            match_info = parser.pairs_by_label(record, "MIT", "MIV")
            continue
        if "III" in keys:
            incident = _parse_incident(record)
            incident["period"] = current_period
            incidents.append(incident)
            continue
        if "AC" in keys and "III" not in keys:
            current_period = parser.to_dict(record).get("AC")
            continue

    return MatchSummary(match_id=match_id, match_info=match_info, incidents=incidents)


# -------------------------------------------------------------- stats -----

def get_match_stats(sport_id: int, match_id: str, *, session=None) -> List[dict]:
    """
    Returns a flat list of stat rows:
      {"period": "Match" | "1st Half" | "2nd Half", "category": "Top stats" | "Shots" | ...,
       "stat": "Expected goals (xG)", "home": "0.34", "away": "1.04"}

    Values are left as strings on purpose -- some are plain numbers ("7"),
    some are percentages ("39%"), some are "81% (273/339)". Convert as
    needed for your use case.
    """
    resp = fetch_feed(f"df_st_{sport_id}_{match_id}", session=session)
    text = resp.text.strip()
    if not text or text == "0":
        return []

    rows: List[dict] = []
    current_period = None
    current_category = None

    for record in parser.parse_records(text):
        d = parser.to_dict(record)
        keys = set(d)
        if keys == {"SE"}:
            current_period = d["SE"]
            continue
        if keys == {"SF"}:
            current_category = d["SF"]
            continue
        if "SD" in keys:
            rows.append(
                {
                    "period": current_period,
                    "category": current_category,
                    "stat": d.get("SG"),
                    "home": d.get("SH"),
                    "away": d.get("SI"),
                }
            )
    return rows


# ------------------------------------------------------------ lineups -----

def get_match_lineups(sport_id: int, match_id: str, *, session=None) -> dict:
    """Returns {"formation": {"home": "...", "away": "..."}, "home": [...players], "away": [...players]}"""
    resp = fetch_feed(f"df_li_{sport_id}_{match_id}", session=session)
    text = resp.text.strip()
    if not text or text == "0":
        return {"formation": {}, "home": [], "away": []}

    players = {"home": [], "away": []}
    formation = {}
    current_side = "home"
    current_section = "Starting Lineups"

    for record in parser.parse_records(text):
        d = parser.to_dict(record)
        keys = set(d)

        if "LC" in keys:
            current_side = "home" if d.get("LC") == "1" else "away"
            # Deliberately no `continue` here: a side-switch record can also
            # carry a section label (e.g. "LB") in the same record.
        if "LB" in keys:
            current_section = d.get("LB", current_section)
        if "LD" in keys and current_side not in formation:
            # The formation string rides along on the same record as the
            # first player (e.g. {"LD": "1-4-2-3-1", "LP": "...", ...}),
            # so this is checked independently of whether "LP" is present
            # rather than as a separate record type.
            formation[current_side] = d.get("LD")
        if "LP" in keys:
            players[current_side].append(
                {
                    "section": current_section,
                    "player_id": d.get("LP"),
                    "name": d.get("LI"),
                    "short_name": d.get("LN"),
                    "shirt_number": d.get("LJ"),
                    "nationality": d.get("LQ"),
                    "rating": d.get("LPR"),
                    "is_captain": d.get("LS") == "Captain",
                    "substituted": "LII" in d,
                    "substituted_at": d.get("LIT") if "LII" in d else None,
                    "substituted_for": d.get("LIN") if "LII" in d else None,
                }
            )
            continue

    return {"formation": formation, "home": players["home"], "away": players["away"]}


def get_match_full(sport_id: int, match_id: str, *, session=None) -> dict:
    """Convenience: core state + summary in one call (the two cheapest, most-used feeds)."""
    core = get_match_core(sport_id, match_id, session=session)
    summary = get_match_summary(sport_id, match_id, session=session)
    return {
        "core": core.__dict__ if core else None,
        "match_info": summary.match_info,
        "incidents": summary.incidents,
    }
