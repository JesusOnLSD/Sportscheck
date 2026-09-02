"""
Generic parser for Flashscore's feed text format.

Every feed (fixtures, live scores, match stats, standings, ...) uses the
same three-level delimiter scheme:

  - records are separated by "~"
  - within a record, fields are separated by "¬"   (the "not" sign, ¬)
  - within a field, the key and value are separated by "÷" (the
    division sign, ÷), e.g. "AA÷pMYI1J6k"

A feed is a flat, ordered SEQUENCE of records. Some records are "header" /
"state" records (e.g. "which tournament are the following matches from",
"which time period do the following stat rows belong to") and the records
that follow them belong to that state until a new header record appears.
That grouping logic is specific to each feed type, so this module only
does the generic, lossless part: turning the raw text into an ordered
list of records, where each record is an ordered list of (key, value)
pairs (duplicates and order preserved, since some records intentionally
repeat a key -- e.g. label/value pairs like MIT/MIV for "Referee",
"Attendance", etc).

Higher-level modules (fixtures.py, match_detail.py, standings.py) know
what a given feed's records mean and turn them into normal Python
dicts/lists.
"""

from __future__ import annotations

from typing import List, Tuple

Field = Tuple[str, str]
Record = List[Field]

FIELD_SEP = "¬"  # ¬
KV_SEP = "÷"  # ÷
RECORD_SEP = "~"


def parse_records(text: str) -> List[Record]:
    """Split raw feed text into an ordered list of records of (key, value) pairs."""
    records: List[Record] = []
    for raw_record in text.split(RECORD_SEP):
        raw_record = raw_record.strip(FIELD_SEP)
        if not raw_record:
            continue
        fields: Record = []
        for chunk in raw_record.split(FIELD_SEP):
            if not chunk:
                continue
            if KV_SEP in chunk:
                key, _, value = chunk.partition(KV_SEP)
                fields.append((key, value))
            else:
                # A stray chunk with no separator -- keep it rather than
                # silently dropping data we don't understand.
                fields.append((chunk, ""))
        if fields:
            records.append(fields)
    return records


def record_keys(record: Record) -> set:
    return {k for k, _ in record}


def to_dict(record: Record) -> dict:
    """First occurrence of each key wins. Good for records where keys don't repeat."""
    result: dict = {}
    for key, value in record:
        if key not in result:
            result[key] = value
    return result


def to_multidict(record: Record) -> dict:
    """Every value for a key is kept, in order, as a list."""
    result: dict = {}
    for key, value in record:
        result.setdefault(key, []).append(value)
    return result


def pairs_by_label(record: Record, label_key: str, value_key: str) -> dict:
    """
    For records that encode label/value pairs by repeating two keys in lockstep,
    e.g. MIT÷REF ¬ MIV÷Backhouse A. ¬ MIT÷VEN ¬ MIV÷St. Andrew's Stadium
    -> {"REF": "Backhouse A.", "VEN": "St. Andrew's Stadium"}
    """
    labels = [v for k, v in record if k == label_key]
    values = [v for k, v in record if k == value_key]
    return dict(zip(labels, values))
