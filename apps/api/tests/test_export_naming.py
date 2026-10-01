"""Unit tests for services/export_naming.build_export_name. No DB, no GCP."""

from __future__ import annotations

import pytest

from cleanshot_api.services.export_naming import (
    Inventory,
    build_export_name,
    default_inventory,
)


def name(**kw):
    """The naming function with the CSV switched off unless a test opts in."""
    kw.setdefault("inventory", None)
    return build_export_name(**kw)


FULL = dict(make="Lift Hero", year=2024, model="CPD30", tire="Pneumatic",
            capacity="6000", fuel="Electric")


# ── the format itself ────────────────────────────────────────────────────────

def test_spec_example_folder_and_file():
    assert name(**FULL) == "LIFT_HERO_2024_CPD30_P-6K_E"
    assert name(**FULL, sequence=1, total=5, ext="jpg") == "LIFT_HERO_2024_CPD30_P-6K_E_01.jpg"


def test_sequence_pads_to_two_digits_and_widens_for_big_batches():
    assert name(**FULL, sequence=7, total=9, ext="png").endswith("_07.png")
    assert name(**FULL, sequence=12, total=12, ext=".jpg").endswith("_12.jpg")
    assert name(**FULL, sequence=3, total=150, ext="jpg").endswith("_003.jpg")


def test_lowercase_input_is_uppercased():
    assert name(make="lift hero", model="cpd30") == "LIFT_HERO_CPD30"


# ── abbreviation normalisation ───────────────────────────────────────────────

@pytest.mark.parametrize("tire,code", [
    ("Pneumatic", "P"), ("pneumatic", "P"), ("P", "P"), ("p", "P"),
    ("Pneumatic tires", "P"),
    ("Cushion", "C"), ("CUSHION", "C"), ("c", "C"), ("cushion tire", "C"),
])
def test_tire_normalisation(tire, code):
    assert name(make="X", tire=tire, capacity="5000") == f"X_{code}-5K"


@pytest.mark.parametrize("tire", ["Non-marking", "Solid", "air", "unknown", ""])
def test_unrecognised_tire_is_omitted_not_guessed(tire):
    assert name(make="X", tire=tire, capacity="5000") == "X_5K"


@pytest.mark.parametrize("fuel,code", [
    ("Diesel", "D"), ("d", "D"),
    ("Gas", "G"), ("gasoline", "G"), ("G", "G"),
    ("LP", "LP"), ("lp", "LP"), ("LPG", "LP"), ("Propane", "LP"), ("LP (Propane)", "LP"),
    ("Dual", "DUAL"), ("dual fuel", "DUAL"), ("Dual-Fuel", "DUAL"), ("LP/Gas", "DUAL"),
    ("Electric", "E"), ("e", "E"), ("80V Lithium-Ion", "E"),
])
def test_fuel_normalisation(fuel, code):
    assert name(make="X", fuel=fuel) == f"X_{code}"


@pytest.mark.parametrize("fuel", ["Hydrogen", "unknown", "", None])
def test_unrecognised_fuel_is_omitted(fuel):
    assert name(make="X", fuel=fuel) == "X"


# ── capacity formatting ──────────────────────────────────────────────────────

@pytest.mark.parametrize("capacity,formatted", [
    ("22000", "22K"), ("5500", "5.5K"), ("6000", "6K"), ("500", ".5K"),
    ("6000.0", "6K"), ("4750", "4.75K"), ("18500", "18.5K"),
    ("5,000", "5K"), ("5000 lbs", "5K"), ("5000lb", "5K"), ("5000 #", "5K"),
    ("5000 lbs @ 24in load center", "5K"), ("5.5K", "5.5K"), ("6k", "6K"),
    (22000, "22K"),
])
def test_capacity_formatting(capacity, formatted):
    assert name(make="X", capacity=capacity) == f"X_{formatted}"


@pytest.mark.parametrize("capacity", ["2500 kg", "heavy", "0", "unknown", ""])
def test_unparseable_capacity_is_omitted(capacity):
    assert name(make="X", capacity=capacity) == "X"


# ── missing fields drop with their separator ─────────────────────────────────

def test_missing_year_drops_its_underscore():
    assert name(**{**FULL, "year": None}) == "LIFT_HERO_CPD30_P-6K_E"


def test_tire_without_capacity_and_capacity_without_tire():
    assert name(**{**FULL, "capacity": ""}) == "LIFT_HERO_2024_CPD30_P_E"
    assert name(**{**FULL, "tire": ""}) == "LIFT_HERO_2024_CPD30_6K_E"


def test_web_form_unknown_sentinel_is_blank():
    # ExportControls saves blank tire / capacity / fuel as the word "unknown".
    assert name(make="Hyster", model="H50FT", tire="unknown",
                capacity="unknown", fuel="unknown") == "HYSTER_H50FT"


def test_everything_missing_still_produces_a_name():
    assert name() == "FORKLIFT"
    assert name(sequence=1, ext="jpg") == "FORKLIFT_01.jpg"


def test_invalid_year_is_omitted():
    assert name(make="X", year="19") == "X"
    assert name(make="X", year="NEW!") == "X"


def test_unsafe_characters_are_stripped():
    out = name(make='Lift: Hero?', model='CBD20-E1C1L/SL20L3', fuel="E")
    assert out == "LIFT_HERO_CBD20-E1C1L_SL20L3_E"
    assert name(model="CPDB(D)30AC  EX RATED") == "CPDB_D_30AC_EX_RATED"
    assert name(model="CPD30- MODEX") == "CPD30-MODEX"
    assert name(make="Clark Équipment") == "CLARK_EQUIPMENT"
    assert all(c.isalnum() or c in "_-." for c in name(make='a<b>c"d|e*f\\g'))


# ── CSV fallback ─────────────────────────────────────────────────────────────

def inv(*rows):
    """Build an Inventory from 11-column rows shaped like the real CSV."""
    return Inventory.from_csv_rows(rows)


def row(make, year, model, capacity, fuel="", shadow=None):
    r = ["", make, "", year, "", model, "", "Single Drive", "", capacity, fuel]
    for i, v in (shadow or {}).items():
        r[i] = v
    return r


def test_csv_fills_blank_fields_from_a_unique_match():
    i = inv(row("LIFT HERO", "2026", "LG50B", "11000"))
    assert build_export_name(make="Lift Hero", model="LG50B", inventory=i) == \
        "LIFT_HERO_2026_LG50B_11K"


def test_csv_never_overrides_what_the_operator_typed():
    i = inv(row("LIFT HERO", "2026", "LG50B", "11000", "80V Lithium-Ion"))
    out = build_export_name(make="Lift Hero", year=2019, model="LG50B",
                            capacity="10000", fuel="Diesel", inventory=i)
    assert out == "LIFT_HERO_2019_LG50B_10K_D"


def test_csv_fuel_spelling_is_normalised():
    i = inv(row("LIFT HERO", "2026", "CPD38", "9000", "80V Lithium-Ion"))
    assert build_export_name(make="Lift Hero", model="CPD38", inventory=i).endswith("_9K_E")


def test_conflicting_years_leave_year_blank_but_agreeing_capacity_fills():
    i = inv(row("LIFT HERO", "2023", "CPD25", "5000"),
            row("LIFT HERO", "2025", "CPD25", "5000"))
    assert build_export_name(make="Lift Hero", model="CPD25", inventory=i) == \
        "LIFT_HERO_CPD25_5K"


def test_conflicting_capacities_leave_capacity_blank():
    i = inv(row("LIFT HERO", "2026", "CPD30", "6000"),
            row("LIFT HERO", "2026", "CPD30", "6500"))
    assert build_export_name(make="Lift Hero", model="CPD30", inventory=i) == \
        "LIFT_HERO_2026_CPD30"


def test_one_blank_fuel_row_makes_fuel_ambiguous():
    i = inv(row("LIFT HERO", "2023", "CPD30", "6000", "LP (Propane)"),
            row("LIFT HERO", "2023", "CPD30", "6000", ""))
    assert build_export_name(make="Lift Hero", model="CPD30", inventory=i) == \
        "LIFT_HERO_2023_CPD30_6K"


def test_model_match_ignores_case_and_stray_whitespace():
    i = inv(row("LIFT HERO", "2024", " LG25GLT ", "5000"))
    assert build_export_name(make="lift hero", model="lg25glt", inventory=i) == \
        "LIFT_HERO_2024_LG25GLT_5K"


def test_model_match_is_exact_not_fuzzy():
    i = inv(row("LIFT HERO", "2026", "CPD30- MODEX", "6000"))
    assert build_export_name(make="Lift Hero", model="CPD30", inventory=i) == \
        "LIFT_HERO_CPD30"


def test_make_mismatch_means_no_match():
    i = inv(row("OCTANE", "2026", "FB40", "9000"))
    assert build_export_name(make="Lift Hero", model="FB40", inventory=i) == "LIFT_HERO_FB40"


def test_make_comes_from_csv_when_blank_and_unanimous():
    i = inv(row("OCTANE", "2026", "FB40", "9000"))
    assert build_export_name(model="FB40", inventory=i) == "OCTANE_2026_FB40_9K"


def test_same_model_under_two_makes_without_make_is_ambiguous():
    i = inv(row("OCTANE", "2026", "FB40", "9000"), row("LIFT HERO", "2025", "FB40", "8000"))
    assert build_export_name(model="FB40", inventory=i) == "FB40"


def test_no_model_means_no_lookup():
    i = inv(row("LIFT HERO", "2026", "LG50B", "11000"))
    assert build_export_name(make="Lift Hero", inventory=i) == "LIFT_HERO"


def test_no_match_leaves_fields_blank():
    assert build_export_name(make="Toyota", model="8FGU25",
                             inventory=inv(row("LIFT HERO", "2026", "LG50B", "11000"))) == \
        "TOYOTA_8FGU25"


def test_non_numeric_csv_year_is_never_used():
    i = inv(row("LIFT HERO", "NEW!", "WIDE Class 3 SS/FP", "8000"))
    assert build_export_name(make="Lift Hero", model="WIDE Class 3 SS/FP", inventory=i) == \
        "LIFT_HERO_WIDE_CLASS_3_SS_FP_8K"


def test_row_whose_shadow_column_contradicts_is_skipped():
    # The real CSV's row 105: shadow model CPYD35-XL vs main CPD35.
    i = inv(row("LIFT HERO", "2025", "CPD35", "8000",
                shadow={0: "LIFT HERO", 4: "CPYD35-XL", 6: "Dual Drive", 8: "8000"}),
            row("LIFT HERO", "2024", "CPD35", "8000"))
    assert build_export_name(make="Lift Hero", model="CPD35", inventory=i) == \
        "LIFT_HERO_2024_CPD35_8K"


def test_short_rows_do_not_crash():
    i = Inventory.from_csv_rows([["", "LIFT HERO", "", "2024", "", "LG16BE"], []])
    assert build_export_name(make="Lift Hero", model="LG16BE", inventory=i) == \
        "LIFT_HERO_2024_LG16BE"


# ── the packaged CSV ─────────────────────────────────────────────────────────

def test_packaged_csv_loads_and_resolves_known_rows():
    # LG50B appears once (2026, 11000 lbs). CPD30 spans 2023/2024/2026 and
    # 6000/6500, so it must get NEITHER a year nor a capacity.
    assert build_export_name(make="Lift Hero", model="LG50B") == "LIFT_HERO_2026_LG50B_11K"
    assert build_export_name(make="LIFT HERO", model="CPD30") == "LIFT_HERO_CPD30"
    assert build_export_name(make="Hyster", model="E60XM2-33") == "HYSTER_2001_E60XM2-33_6K"


def test_unreadable_csv_does_not_block_naming(monkeypatch, tmp_path):
    from cleanshot_api.services import export_naming

    monkeypatch.setattr(export_naming, "INVENTORY_CSV", tmp_path / "missing.csv")
    default_inventory.cache_clear()
    try:
        assert build_export_name(make="Lift Hero", model="LG50B") == "LIFT_HERO_LG50B"
    finally:
        default_inventory.cache_clear()
