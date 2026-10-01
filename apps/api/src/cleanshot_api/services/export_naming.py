"""
Export naming: one function, `build_export_name`, names both the export folder
and every image in it.

    MAKE_YEAR_MODEL_TIRE-CAPACITY_FUEL            folder / ZIP stem
    MAKE_YEAR_MODEL_TIRE-CAPACITY_FUEL_01.jpg     image

    e.g. LIFT_HERO_2024_CPD30_P-6K_E_01.jpg

Rules that are easy to break by accident:

* **Missing data never blocks export.** A field that is blank (or the literal
  "unknown" the web form saves for a blank tire / capacity / fuel) is dropped
  together with its separator. Nothing is ever replaced by a placeholder.
* **Unrecognised is treated as missing.** "Non-marking" is not P or C, and
  "2500 kg" is not a pound rating, so both are omitted rather than coerced.
* **The year is never inferred.** It comes from the operator, or from the
  inventory CSV only when every row for that make + model carries the same
  year. A model stocked in several years gets no year.

The inventory CSV (`data/title-inference-csv.csv`, a packaged copy of
`reference/title-inference-csv.csv`; the Dockerfile ships only `src/`) has NO
header row, so columns are positional. Observed layout, 2026-10-01:

    col 0  make  (shadow)    col 1  make
    col 2  year  (shadow)    col 3  year
    col 4  model (shadow)    col 5  model
    col 6  drive (shadow)    col 7  drive      -- not part of the name
    col 8  cap.  (shadow)    col 9  capacity, lbs
    col 10 fuel              -- 3 of 134 rows; there is NO tire column

The shadow columns are filled on one row only, and there they contradict the
main column (CPYD35-XL vs CPD35), so a row whose shadow disagrees with its
main column is skipped as unreliable rather than half-trusted.
"""

from __future__ import annotations

import csv
import logging
import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

INVENTORY_CSV = Path(__file__).resolve().parent.parent / "data" / "title-inference-csv.csv"

# What the web form saves when a field is left blank (ExportControls
# saveProjectMetadata), plus the obvious hand-typed equivalents.
_BLANK_SENTINELS = {"unknown", "n/a", "na", "none", "null", "-"}

_TIRE_CODES = {
    "p": "P", "pneumatic": "P",
    "c": "C", "cushion": "C",
}

_FUEL_CODES = {
    "d": "D", "diesel": "D",
    "g": "G", "gas": "G", "gasoline": "G", "petrol": "G",
    "lp": "LP", "lpg": "LP", "lp gas": "LP", "propane": "LP", "liquid propane": "LP",
    "dual": "DUAL", "dual fuel": "DUAL",
    "lp/gas": "DUAL", "gas/lp": "DUAL", "lpg/gas": "DUAL", "gas/lpg": "DUAL",
    "e": "E", "electric": "E", "battery": "E",
    "lithium": "E", "lithium ion": "E", "li ion": "E",
}

# Characters allowed in a name. Everything else, whitespace included, becomes
# an underscore separator, so "CBD20/SL20L3" stays two tokens instead of
# fusing into one model number.
_UNSAFE_RE = re.compile(r"[^A-Z0-9.\-]+")

# number, optional K, optional pound unit, optional "@ 24in load center" tail
_CAPACITY_RE = re.compile(
    r"^(?P<num>\d+(?:\.\d+)?|\.\d+)\s*(?P<k>k)?\s*(?:lbs?\.?|pounds?|#)?"
    r"\s*(?:(?:@|\bat\b).*)?$"
)
_YEAR_RE = re.compile(r"^(19|20)\d\d$")


def _text(value: object) -> str:
    """Trimmed text, or '' for None and for the blank sentinels."""
    s = "" if value is None else str(value).strip()
    return "" if s.lower() in _BLANK_SENTINELS else s


def _safe(value: str) -> str:
    """Uppercase, spaces to underscores, unsafe characters removed."""
    s = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    s = _UNSAFE_RE.sub("_", s.upper())
    s = re.sub(r"_*-_*", "-", s)          # "CPD30- MODEX" -> CPD30-MODEX
    s = re.sub(r"_+", "_", s)
    return s.strip("_.-")


def _tire(value: object) -> str:
    s = re.sub(r"\s+tires?$", "", _text(value).lower())
    return _TIRE_CODES.get(s, "")


def _fuel(value: object) -> str:
    s = _text(value).lower()
    s = re.sub(r"\(.*?\)", " ", s)               # "LP (Propane)" -> "lp"
    s = re.sub(r"^\d+\s*v(olts?)?\b", " ", s)     # "80V Lithium-Ion" -> "lithium-ion"
    s = re.sub(r"[\s-]+", " ", s).strip()
    s = re.sub(r"\s*/\s*", "/", s)
    return _FUEL_CODES.get(s, "")


def _year(value: object) -> str:
    s = _text(value)
    return s if _YEAR_RE.match(s) else ""


def _capacity(value: object) -> str:
    """Pounds condensed to thousands: 22000 -> 22K, 5500 -> 5.5K, 500 -> .5K."""
    s = _text(value).lower().replace(",", "")
    m = _CAPACITY_RE.match(s)
    if not m:
        return ""
    try:
        lbs = Decimal(m.group("num")) * (1000 if m.group("k") else 1)
    except InvalidOperation:
        return ""
    if lbs <= 0:
        return ""
    k = (lbs / 1000).quantize(Decimal("0.001")).normalize()
    if k == 0:
        return ""
    text = f"{k:f}"
    if text.startswith("0."):
        text = text[1:]
    return f"{text}K"


def _key(value: object) -> str:
    """Match key for make / model: case- and whitespace-insensitive only."""
    return re.sub(r"\s+", "", _text(value)).upper()


@dataclass(frozen=True)
class InventoryRow:
    make: str
    year: str
    model: str
    capacity: str
    fuel: str


class Inventory:
    """Rows from the inventory CSV, looked up by make + model."""

    # (shadow, main) column pairs; see module docstring.
    _PAIRS = ((0, 1), (2, 3), (4, 5), (6, 7), (8, 9))

    def __init__(self, rows: Iterable[InventoryRow]):
        self._by_model: dict[str, list[InventoryRow]] = {}
        for row in rows:
            if _key(row.model):
                self._by_model.setdefault(_key(row.model), []).append(row)

    @classmethod
    def from_csv_rows(cls, raw_rows: Iterable[Sequence[str]]) -> Inventory:
        rows = []
        for raw in raw_rows:
            cells = [c.strip() for c in raw] + [""] * (11 - len(raw))
            if any(cells[s] and _key(cells[s]) != _key(cells[m]) for s, m in cls._PAIRS):
                continue
            rows.append(InventoryRow(
                make=cells[1], year=cells[3], model=cells[5],
                capacity=cells[9], fuel=cells[10],
            ))
        return cls(rows)

    @classmethod
    def from_path(cls, path: Path) -> Inventory:
        with path.open(newline="", encoding="utf-8-sig") as f:
            return cls.from_csv_rows(csv.reader(f))

    def lookup(self, *, make: str, model: str) -> dict[str, str]:
        """
        Fields every matching row agrees on, normalised. A field is filled
        only when ALL matching rows carry the same recognisable value; one
        blank or one disagreeing row leaves it empty.
        """
        rows = self._by_model.get(_key(model), [])
        if _key(make):
            rows = [r for r in rows if _key(r.make) == _key(make)]
        if not rows:
            return {}
        fields = {
            "make": [_text(r.make) for r in rows],
            "year": [_year(r.year) for r in rows],
            "capacity": [_capacity(r.capacity) for r in rows],
            "fuel": [_fuel(r.fuel) for r in rows],
        }
        out = {}
        for name, values in fields.items():
            keys = {_key(v) for v in values}
            if len(keys) == 1 and "" not in keys:
                out[name] = values[0]
        return out


@lru_cache(maxsize=1)
def default_inventory() -> Inventory:
    """The packaged CSV, loaded once. A missing or unreadable file is an empty
    inventory, never an export failure."""
    try:
        return Inventory.from_path(INVENTORY_CSV)
    except Exception:
        logger.exception("Inventory CSV unreadable at %s; naming without it", INVENTORY_CSV)
        return Inventory([])


_DEFAULT = object()


def build_export_name(
    *,
    make: object = None,
    year: object = None,
    model: object = None,
    tire: object = None,
    capacity: object = None,
    fuel: object = None,
    sequence: int | None = None,
    total: int = 1,
    ext: str | None = None,
    inventory: Inventory | None | object = _DEFAULT,
) -> str:
    """
    MAKE_YEAR_MODEL_TIRE-CAPACITY_FUEL, with `_NN.ext` appended when
    `sequence` (1-based) is given. Blank fields are filled from the inventory
    CSV where it is unambiguous, and anything still blank is omitted.

    `inventory=None` disables the CSV lookup; the default uses the packaged one.
    The sequence is zero-padded to at least two digits, wider for batches of
    100+, so names sort correctly in any file explorer.
    """
    if inventory is _DEFAULT:
        inventory = default_inventory()

    given = {"make": _text(make), "year": _year(year), "model": _text(model),
             "capacity": _capacity(capacity), "fuel": _fuel(fuel)}
    raw_blank = {"make": not _text(make), "year": not _text(year),
                 "capacity": not _text(capacity), "fuel": not _text(fuel)}

    if isinstance(inventory, Inventory) and given["model"] and any(raw_blank.values()):
        found = inventory.lookup(make=given["make"], model=given["model"])
        for field, blank in raw_blank.items():
            if blank and field in found:
                given[field] = found[field]

    tire_capacity = "-".join(p for p in (_tire(tire), given["capacity"]) if p)
    parts = [_safe(given["make"]), given["year"], _safe(given["model"]),
             tire_capacity, given["fuel"]]
    base = "_".join(p for p in parts if p) or "FORKLIFT"

    if sequence is None:
        return base
    width = max(2, len(str(max(total, sequence))))
    name = f"{base}_{str(sequence).zfill(width)}"
    return f"{name}.{ext.lstrip('.')}" if ext else name
