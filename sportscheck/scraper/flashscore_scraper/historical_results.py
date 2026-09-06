"""
Historical match results for a SPECIFIC past season.

Background on why this works the way it does: Flashscore's day-offset
fixtures feed (used by fixtures.py for "today ± N days") returns nothing
at all past roughly a year back -- confirmed empirically, it comes back
genuinely empty rather than erroring, for any sport or league. So a
5-year backfill via that route silently finds nothing, which is exactly
what happened before this module existed.

The season results page, however, embeds its ENTIRE season's match data
directly in the page HTML, inside a JavaScript assignment:

    cjs.initialFeeds['results'] = { data: `SA÷1¬~ZA÷ENGLAND: ...`, allEventsCount: 380, seasonId: 183 }

That embedded blob is in the exact same delimited format every other
Flashscore feed uses, so parse_fixtures_text() -- already proven for the
day-offset feed -- reads it completely unmodified. Verified against real
captured 2023-24 data (Liverpool 2-0 Wolves, Luton 2-4 Fulham, both
round 38) before this module was written.

The same page also embeds a "season_list" mapping every season name to
its tournament/stage IDs, which get_available_seasons() extracts -- that
gives a reliable list of what seasons exist without guessing.
"""

import re
from typing import List, Optional

from .feed_client import fetch_url_text
from .fixtures import Match, parse_fixtures_text


# The season's whole match list sits in a backtick-quoted JS template
# literal. Non-greedy up to the closing backtick-comma so we stop at the
# end of the data field rather than running into later page content.
_RESULTS_FEED_RE = re.compile(
    r"cjs\.initialFeeds\['results'\]\s*=\s*\{\s*data:\s*`(.*?)`,",
    re.DOTALL,
)

# Same idea for the fixtures (upcoming) block on a season page.
_FIXTURES_FEED_RE = re.compile(
    r"cjs\.initialFeeds\['fixtures'\]\s*=\s*\{\s*data:\s*`(.*?)`,",
    re.DOTALL,
)

# season_list entries look like:
#   {"id":3,"name":"2023\/2024","pathname":"\/standings\/jDTEm9zs\/I3O5jpB2\/"}
# Note the escaped forward slashes -- this is JSON embedded in JS, so
# "/" appears as "\/" throughout.
_SEASON_LIST_RE = re.compile(
    r'"name":"([^"]+)","pathname":"\\/standings\\/([^\\]+)\\/([^\\]+)\\/"'
)


def _season_slug(season_label: str, sport: str = "football", country: str = "england",
                 competition: str = "premier-league") -> str:
    """Builds e.g. 'premier-league-2023-2024' from '2023-2024'."""
    return f"{competition}-{season_label}"


def get_historical_results(
    season_label: str,
    country: str = "england",
    competition: str = "premier-league",
    sport: str = "football",
) -> List[Match]:
    """
    Returns every match of a past season, parsed from that season's
    results page.

    season_label is the full-year form, e.g. "2023-2024".

    Returns an empty list (rather than raising) when the page loads but
    contains no embedded results block -- that legitimately happens for
    a season with no played matches yet.
    """
    slug = _season_slug(season_label, sport, country, competition)
    url = f"https://www.flashscore.com/{sport}/{country}/{slug}/results/"

    html = fetch_url_text(url)

    matches: List[Match] = []
    seen_ids = set()

    for pattern in (_RESULTS_FEED_RE, _FIXTURES_FEED_RE):
        found = pattern.search(html)
        if not found:
            continue
        blob = found.group(1)
        if not blob.strip():
            continue
        for match in parse_fixtures_text(blob, sport):
            # A match can appear in both blocks; keep the first.
            if match.match_id in seen_ids:
                continue
            seen_ids.add(match.match_id)
            matches.append(match)

    return matches


def get_available_seasons(
    country: str = "england",
    competition: str = "premier-league",
    sport: str = "football",
) -> List[dict]:
    """
    Returns every season Flashscore lists for this competition, each as
    {"name": "2023/2024", "tournamentId": ..., "stageId": ...}.

    Read from the season_list embedded in the current season's page, so
    this reflects what Flashscore actually has rather than assuming a
    fixed range of years.
    """
    url = f"https://www.flashscore.com/{sport}/{country}/{competition}/"
    html = fetch_url_text(url)

    seasons = []
    for name, tournament_id, stage_id in _SEASON_LIST_RE.findall(html):
        seasons.append({
            # Names come through as "2023\/2024"; normalise the escaping.
            "name": name.replace("\\/", "/"),
            "tournamentId": tournament_id,
            "stageId": stage_id,
        })
    return seasons


def season_label_from_name(season_name: str) -> Optional[str]:
    """
    Converts a Flashscore season name ("2023/2024") into the URL label
    form ("2023-2024"). Returns None for anything that doesn't look like
    a two-year season name, so callers can skip odd entries rather than
    building a broken URL.
    """
    match = re.fullmatch(r"(\d{4})/(\d{4})", season_name.strip())
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2)}"
