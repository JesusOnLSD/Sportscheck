"""
Fixtures / live scores / results.

Flashscore's daily fixtures feed is a single request that returns EVERY
match for one sport on one day, across every country and competition:

    f_<sportId>_<dayOffset>_2_en_1

  sportId   - see sports.py (soccer=1, basketball=3, hockey=4, baseball=6, esports=36)
  dayOffset - 0 = today, 1 = tomorrow, -1 = yesterday, 2 = day after tomorrow, etc.
              (confirmed live: each step changes the first match's kickoff time by ~1 day)

There is no separate "live" or "finished" feed -- the site's ALL/LIVE/
FINISHED/SCHEDULED tabs just filter this same data client-side by status,
which is what get_fixtures()'s `status` argument does here too.

The response is one long list of records (see parser.py): tournament
"header" records, each followed by the matches in that tournament, until
the next header. This module walks that sequence, keeping track of the
current tournament, and turns each match record into a plain dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, List, Optional

from . import parser
from .feed_client import fetch_feed
from .sports import SPORT_IDS

# AB status codes, confirmed empirically on 2026-09-01 by comparing
# against the rendered page (scheduled/live/finished tabs). Flashscore
# likely has more codes for postponed/cancelled/walkover matches that
# we haven't observed a live example of -- those come through with
# status="unknown" and status_raw set, rather than being guessed at.
STATUS_MAP = {
    "1": "scheduled",
    "2": "live",
    "3": "finished",
}


def _iso(unix_ts: Optional[str]) -> Optional[str]:
    if not unix_ts:
        return None
    try:
        return datetime.fromtimestamp(int(unix_ts), tz=timezone.utc).isoformat()
    except (ValueError, OSError):
        return None


@dataclass
class Match:
    match_id: str
    sport: str
    country: str
    tournament_name: str
    tournament_id: str
    kickoff_utc: Optional[str]
    kickoff_unix: Optional[int]
    status: str
    status_raw: Optional[str]
    home_team: str
    home_team_id: str
    away_team: str
    away_team_id: str
    home_score: Optional[int]
    away_score: Optional[int]
    added_time: Optional[str] = None
    raw: dict = field(default_factory=dict, repr=False)

    def to_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k != "raw"}
        return d


def _build_match(tournament: dict, sport: str, rec_dict: dict) -> Match:
    def _int(key):
        v = rec_dict.get(key)
        return int(v) if v not in (None, "") else None

    ab = rec_dict.get("AB")
    return Match(
        match_id=rec_dict.get("AA", ""),
        sport=sport,
        country=tournament.get("country", ""),
        tournament_name=tournament.get("competition_name", ""),
        tournament_id=tournament.get("tournament_id", ""),
        kickoff_utc=_iso(rec_dict.get("AD")),
        kickoff_unix=_int("AD"),
        status=STATUS_MAP.get(ab, "unknown"),
        status_raw=ab,
        home_team=rec_dict.get("CX", ""),
        home_team_id=rec_dict.get("PX", ""),
        away_team=rec_dict.get("AF", ""),
        away_team_id=rec_dict.get("PY", ""),
        home_score=_int("AG"),
        away_score=_int("AH"),
        added_time=rec_dict.get("WL") or None,
        raw=rec_dict,
    )


def parse_fixtures_text(text: str, sport: str) -> List[Match]:
    """Parse raw f_<sport>_<offset>_2_en_1 feed text into a list of Match objects."""
    matches: List[Match] = []
    current_tournament: dict = {}

    for record in parser.parse_records(text):
        keys = parser.record_keys(record)

        if "ZA" in keys:
            d = parser.to_dict(record)
            country = d.get("ZY", "")
            full_name = d.get("ZA", "")
            prefix = f"{country.upper()}: "
            competition_name = full_name[len(prefix):] if full_name.upper().startswith(prefix) else full_name
            current_tournament = {
                "country": country,
                "competition_name": competition_name,
                "tournament_id": d.get("ZC", ""),
                "url_path": d.get("ZL", ""),
            }
            continue

        if "AA" in keys:
            d = parser.to_dict(record)
            matches.append(_build_match(current_tournament, sport, d))

    return matches


def get_fixtures(
    sport: str,
    day_offset: int = 0,
    *,
    status: Optional[str] = None,
    session=None,
) -> List[Match]:
    """
    Fetch every match for `sport` on the day `day_offset` days from today.

    sport       - one of sports.SPORT_IDS ("soccer", "hockey", "basketball", "baseball", "esports")
    day_offset  - 0 = today, 1 = tomorrow, -1 = yesterday, ...
    status      - optionally filter to "scheduled", "live", or "finished"
    """
    if sport not in SPORT_IDS:
        raise ValueError(f"Unknown sport '{sport}'. Known sports: {list(SPORT_IDS)}")

    sport_id = SPORT_IDS[sport]
    code = f"f_{sport_id}_{day_offset}_2_en_1"
    resp = fetch_feed(code, session=session)
    matches = parse_fixtures_text(resp.text, sport)

    if status:
        matches = [m for m in matches if m.status == status]

    return matches


def filter_by_competitions(matches: Iterable[Match], competitions: List[dict]) -> List[Match]:
    """
    Keep only matches whose (country, competition name) matches one of the
    rules in `competitions` (see config/competitions.py for the format:
    each rule is {"country": <name>, "match": "*" or [substring, ...]}).
    """
    rules = []
    for rule in competitions:
        country = rule["country"].lower()
        match = rule["match"]
        needles = None if match == "*" else [m.lower() for m in match]
        rules.append((country, needles))

    kept = []
    for m in matches:
        country_lc = m.country.lower()
        name_lc = m.tournament_name.lower()
        for country, needles in rules:
            if country != country_lc:
                continue
            if needles is None or any(n in name_lc for n in needles):
                kept.append(m)
                break
    return kept
