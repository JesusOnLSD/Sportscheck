"""
flashscore_scraper
===================

A small personal-use client for Flashscore's internal data feed
(the same feed flashscore.com's own web page calls in your browser).

This is NOT an official or public API. It was built by watching the
network requests flashscore.com makes to `2.flashscore.ninja` and
reverse-engineering the response format. See README.md for important
caveats: this can break whenever Flashscore changes something on their
end, and you're responsible for how you use it.
"""

__version__ = "0.1.0"
