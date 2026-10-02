"""Unit tests for services/known_models.py's pure parts. No DB, no GCP.

The SQL paths (seed idempotence, duplicate spellings, hide surviving a
re-seed, rename collisions, the save route) were checked against a real
Postgres on 2026-10-02; they need a database, which these tests do not.
"""

from __future__ import annotations

import pytest

from cleanshot_api.services.export_naming import Inventory, default_inventory
from cleanshot_api.services.known_models import catalog_pairs, match_key, seed_pairs, tidy


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


def test_packaged_catalog_is_loaded_and_clean():
    pairs = catalog_pairs()
    assert len(pairs) > 1000
    keys = [match_key(m, n) for m, n in pairs]
    assert len(keys) == len(set(keys))
    assert ("Skytrak", "8042") in pairs
    # Spaces back where the folder had them; underscores never reach the list.
    assert ("Case", "580 SUPER M SERIES") in pairs
    assert not any("_" in n for _, n in pairs)


@pytest.mark.parametrize("make,model", [
    ("Hyster", "NO MODEL"), ("Hyster", "DIESEL"), ("Hyster", "CUSHION"), ("Toyota", "C"),
    ("Octane", "FD25 P"), ("Lift Hero", "CPD30 CRASHCHAMPIONS"), ("Lift Hero", "CPD30 MODEX"),
    ("Un", "FL25T"), ("Vegas Media", "CGC-60"),
])
def test_catalog_leftovers_are_not_in_the_list(make, model):
    keys = {match_key(m, n) for m, n in catalog_pairs()}
    assert match_key(make, model) not in keys


def test_real_models_that_look_like_leftovers_are_kept():
    keys = {match_key(m, n) for m, n in catalog_pairs()}
    assert match_key("Skyjack", "SJIII 3220") in keys
    assert match_key("Merlo", "P40.13 PLUS") in keys


def test_seed_is_inventory_plus_catalog_one_row_per_pair():
    seed = seed_pairs()
    keys = [match_key(m, n) for m, n in seed]
    assert len(keys) == len(set(keys))
    inv = {match_key(m, n) for m, n in default_inventory().pairs()}
    cat = {match_key(m, n) for m, n in catalog_pairs()}
    assert set(keys) == inv | cat
    # The inventory's spelling is the one kept when both lists have the pair.
    by_key = dict(zip(keys, seed))
    for m, n in default_inventory().pairs():
        assert by_key[match_key(m, n)] == (m, n)
