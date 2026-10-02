"""Unit tests for services/known_models.py's pure parts. No DB, no GCP.

The SQL paths (seed idempotence, duplicate spellings, hide surviving a
re-seed, rename collisions, the save route) were checked against a real
Postgres on 2026-10-02; they need a database, which these tests do not.
"""

from __future__ import annotations

import pytest

from cleanshot_api.services.export_naming import Inventory, default_inventory
from cleanshot_api.services.known_models import match_key, tidy


@pytest.mark.parametrize("a,b", [
    (("Lift Hero", "CPD30"), ("LIFT HERO", "CPD30 ")),
    (("lift hero", "cpd30"), ("LIFT  HERO", " CPD30")),
    (("Toyota", "8FGU25"), ("TOYOTA", "8fgu25")),
])
def test_same_pair_whatever_the_spelling(a, b):
    assert match_key(*a) == match_key(*b)


@pytest.mark.parametrize("a,b", [
    (("Lift Hero", "CPD30"), ("Lift Hero", "CPD30-MODEX")),   # punctuation counts
    (("Lift Hero", "CPD30"), ("Octane", "CPD30")),             # make counts
    (("AB", "C"), ("A", "BC")),                                # the separator keeps them apart
])
def test_different_pairs_stay_different(a, b):
    assert match_key(*a) != match_key(*b)


def test_tidy_trims_and_collapses_inner_whitespace():
    assert tidy("  CPDB(D)30AC  EX RATED ") == "CPDB(D)30AC EX RATED"
    assert tidy(None) == ""


def test_packaged_inventory_pairs_are_distinct_and_named():
    pairs = default_inventory().pairs()
    keys = [match_key(m, n) for m, n in pairs]
    assert len(keys) == len(set(keys))
    assert all(m.strip() and n.strip() for m, n in pairs)
    # 38 raw model spellings in the CSV, four of which differ only by spaces.
    assert len(pairs) == 34
    assert ("Hyster", "E60XM2-33") in pairs


def test_pairs_skip_rows_with_no_make():
    inv = Inventory.from_csv_rows([
        ["", "", "", "2024", "", "CPD20", "", "", "", "4000", ""],
        ["", "LIFT HERO", "", "2024", "", "CPD25", "", "", "", "5000", ""],
    ])
    assert inv.pairs() == [("LIFT HERO", "CPD25")]
