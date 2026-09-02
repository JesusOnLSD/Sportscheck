"""
Flashscore's internal numeric sport IDs.

Confirmed live (2026-09-01) by opening each sport's home page on
flashscore.com and reading which feed code it requested
(f_<sportId>_0_2_en_1):

    football/          -> f_1_...   -> soccer
    basketball/         -> f_3_...   -> basketball (NBA, EuroLeague, ...)
    hockey/              -> f_4_...   -> ice hockey (NHL, SHL, ...)
    baseball/            -> f_6_...   -> baseball (MLB, ...)
    esports/             -> f_36_...  -> esports

Only the sports this project currently uses are listed. Flashscore
covers many more (tennis, handball, volleyball, etc.) -- if you want
one of those, open https://www.flashscore.com/<sport>/ in a browser,
open dev tools -> Network, reload, and look for a request to
`2.flashscore.ninja/2/x/feed/f_<N>_...` to find its ID the same way.
"""

SPORT_IDS = {
    "soccer": 1,
    "basketball": 3,
    "hockey": 4,
    "baseball": 6,
    "esports": 36,
}
