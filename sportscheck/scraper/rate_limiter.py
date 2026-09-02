"""
Shared rate limiter for calls TO FLASHSCORE, used by both push_to_render.py
and backfill_history.py, so there's one single source of truth for the
limit rather than scattered sleep() calls that could drift out of sync.

Deliberately only wraps calls to Flashscore, not calls to your own Render
app — there's no reason to slow down talking to a server you control.
"""

import time

MAX_REQUESTS_PER_MINUTE = 50
MIN_INTERVAL_SECONDS = 60.0 / MAX_REQUESTS_PER_MINUTE  # 1.2 seconds

_last_request_time = [0.0]


def wait_for_rate_limit():
    """Call this immediately before every request to Flashscore. Blocks
    just long enough to guarantee the request rate never exceeds
    MAX_REQUESTS_PER_MINUTE, no matter which function or script calls it."""
    now = time.time()
    elapsed = now - _last_request_time[0]
    if elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_request_time[0] = time.time()
