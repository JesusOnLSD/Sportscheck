"""
Low-level HTTP client for Flashscore's internal feed API.

Everything on flashscore.com (fixtures, live scores, match stats,
standings, ...) is loaded by the page making requests like:

    GET https://2.flashscore.ninja/2/x/feed/<feed_code>
    Header: x-fsign: SW9D1eZo

`<feed_code>` is a short string that identifies what you want, e.g.
`f_1_0_2_en_1` for "today's soccer fixtures". See fixtures.py and
match_detail.py for how those codes are built.

The `x-fsign` value below was captured live from flashscore.com's own
requests on 2026-09-01. It's a fixed string (not a per-request
signature) as far as we could tell, but Flashscore could change it at
any time -- if every request starts failing with 401, this is the
first thing to check (open flashscore.com in a browser, open dev
tools -> Network, filter for "ninja", and look at the request headers
of any request to 2.flashscore.ninja).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

import requests

FEED_BASE_URL = "https://2.flashscore.ninja/2/x/feed"

# Captured from flashscore.com's own network traffic. May need updating
# in the future -- see module docstring.
X_FSIGN = "SW9D1eZo"

DEFAULT_HEADERS = {
    "x-fsign": X_FSIGN,
    # A realistic browser User-Agent makes requests look less like an
    # obvious script. It does not guarantee you won't get rate-limited
    # or blocked -- see README.md.
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.flashscore.com/",
}


class FlashscoreError(Exception):
    """Raised when a feed request fails in a way callers should know about."""


@dataclass
class FeedResponse:
    code: str
    status_code: int
    text: str


def fetch_feed(
    code: str,
    *,
    session: Optional[requests.Session] = None,
    timeout: float = 15.0,
    max_retries: int = 3,
    backoff_seconds: float = 1.5,
) -> FeedResponse:
    """
    Fetch one raw feed by its code, e.g. fetch_feed("f_1_0_2_en_1").

    Retries a couple of times on network errors or 5xx responses (transient
    issues), but does NOT retry on 401/403 -- those mean the auth header is
    wrong or has changed, and hammering the server won't fix that.
    """
    sess = session or requests.Session()
    url = f"{FEED_BASE_URL}/{code}"

    last_exc: Optional[Exception] = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = sess.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < max_retries:
                time.sleep(backoff_seconds * attempt)
                continue
            raise FlashscoreError(f"Network error fetching feed '{code}': {exc}") from exc

        if resp.status_code == 200:
            return FeedResponse(code=code, status_code=200, text=resp.text)

        if resp.status_code in (401, 403):
            raise FlashscoreError(
                f"Feed '{code}' returned {resp.status_code} (unauthorized). "
                "The x-fsign header value has likely changed -- see the "
                "feed_client.py module docstring for how to find the new one."
            )

        if resp.status_code >= 500 and attempt < max_retries:
            time.sleep(backoff_seconds * attempt)
            continue

        raise FlashscoreError(f"Feed '{code}' returned unexpected status {resp.status_code}")

    raise FlashscoreError(f"Failed to fetch feed '{code}' after {max_retries} attempts") from last_exc


def fetch_url_text(
    url: str,
    *,
    session: Optional[requests.Session] = None,
    timeout: float = 15.0,
) -> str:
    """
    Fetch a plain flashscore.com page (not the ninja feed API) and return its
    HTML. Used by standings.py to read the tournament/season IDs that
    Flashscore embeds directly in the page's HTML.
    """
    sess = session or requests.Session()
    resp = sess.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
    if resp.status_code != 200:
        raise FlashscoreError(f"GET {url} returned status {resp.status_code}")
    return resp.text
