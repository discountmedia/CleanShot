"""
The known Make + Model list behind the Make and Model dropdowns (2 Oct 2026).

Settled with Stephen:

* **Seeded from two lists**, then grown by operators: the inventory CSV, and
  (from 2 Oct, later the same day) the forklift catalog, every make and model
  DF has had photos of, built by scripts/build_catalog_models.py into
  data/known_models_catalog.csv with the folder-name leftovers skipped. A make
  and model typed through "Other" joins everyone's list when the project is
  saved. Both seeds are stored as source 'inventory'; the column's CHECK has
  only 'inventory' and 'operator', and 'inventory' here means "a starting
  list", not "currently in stock".
* **Fill nothing.** Picking a known pair fills no other field. The meta columns
  on a row record what the operator entered the first time that pair was saved,
  for reference only; nothing reads them back into a form.
* **Added at once, cleaned up by admins.** A typo becomes a real choice
  straight away. Admins rename or hide entries from the admin dashboard.
  Hiding, not deleting: the seed runs on every API start, and a deleted
  inventory row would simply come back.

ONE ENTRY PER PAIR, whatever the spelling. `match_key` is the make and model
uppercased with all whitespace removed, so "Lift Hero CPD30", "LIFT HERO" +
"CPD30 " and "lift hero" + "cpd30" are one entry. It is the same rule the
inventory lookup in export_naming uses. Hyphens and punctuation still count:
"CPD30-MODEX" and "CPD30" are different models.
"""

from __future__ import annotations

import csv
import logging
import re
from functools import lru_cache
from pathlib import Path

import asyncpg

from cleanshot_api.services.export_naming import default_inventory

logger = logging.getLogger(__name__)

CATALOG_CSV = Path(__file__).resolve().parent.parent / "data" / "known_models_catalog.csv"


def _key_part(value: str | None) -> str:
    return re.sub(r"\s+", "", value or "").upper()


def match_key(make: str | None, model: str | None) -> str:
    return f"{_key_part(make)}|{_key_part(model)}"


def tidy(value: str | None) -> str:
    """How a name is stored for display: trimmed, inner whitespace collapsed."""
    return " ".join((value or "").split())


@lru_cache(maxsize=1)
def catalog_pairs() -> tuple[tuple[str, str], ...]:
    """(make, model) pairs from the packaged catalog list. A missing or
    unreadable file is an empty list, never a startup failure."""
    try:
        with CATALOG_CSV.open(encoding="utf-8", newline="") as f:
            return tuple(
                (row["Make"], row["Model"])
                for row in csv.DictReader(f)
                if (row.get("Make") or "").strip() and (row.get("Model") or "").strip()
            )
    except (OSError, KeyError, csv.Error):
        logger.exception("known_models: could not read %s", CATALOG_CSV)
        return ()


def seed_pairs() -> list[tuple[str, str]]:
    """Every starting pair, inventory first, one per match_key.

    The inventory's spelling wins a tie ("LIFT HERO" over the catalog's
    "Lift Hero") only because it is inserted first; the seed never rewrites
    an existing row, so this order matters on a fresh table only.
    """
    out: dict[str, tuple[str, str]] = {}
    for make, model in [*default_inventory().pairs(), *catalog_pairs()]:
        out.setdefault(match_key(make, model), (make, model))
    return list(out.values())


async def seed_from_inventory(conn: asyncpg.Connection) -> int:
    """Insert every starting pair not already present (inventory CSV and the
    forklift catalog list). Returns rows added.

    ON CONFLICT DO NOTHING is what keeps an admin's rename or hide: an existing
    row, hidden or not, is never touched by the seed.
    """
    pairs = seed_pairs()
    if not pairs:
        return 0
    # One statement for the ~1,150 pairs, so every API start costs one round
    # trip, not one per pair.
    status = await conn.execute(
        """
        INSERT INTO known_models (make, model, match_key, source)
        SELECT make, model, match_key, 'inventory'
          FROM unnest($1::text[], $2::text[], $3::text[]) AS t(make, model, match_key)
        ON CONFLICT (match_key) DO NOTHING
        """,
        [tidy(m) for m, _ in pairs],
        [tidy(n) for _, n in pairs],
        [match_key(m, n) for m, n in pairs],
    )
    # asyncpg returns "INSERT 0 <rows>".
    return int(status.rsplit(" ", 1)[-1])


async def record_from_project(
    conn: asyncpg.Connection,
    *,
    make: str,
    model: str,
    created_by: str | None,
    year: int | None,
    tire_type: str | None,
    capacity: str | None,
    fuel_type: str | None,
    color: str | None,
    dual_drive: bool,
    cab: bool,
) -> bool:
    """Add an operator's pair if it is new. True when a row was added.

    The "unknown" placeholder the export save writes for a blank tire,
    capacity or fuel is stored as NULL, so the reference columns never claim a
    value nobody gave.
    """
    if not _key_part(make) or not _key_part(model):
        return False
    real = lambda v: None if (v or "").strip().lower() in ("", "unknown") else v.strip()  # noqa: E731
    status = await conn.execute(
        """
        INSERT INTO known_models
            (make, model, match_key, source, created_by,
             year, tire_type, capacity, fuel_type, color, dual_drive, cab)
        VALUES ($1, $2, $3, 'operator', $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (match_key) DO NOTHING
        """,
        tidy(make), tidy(model), match_key(make, model), created_by,
        year, real(tire_type), real(capacity), real(fuel_type), real(color), dual_drive, cab,
    )
    return status.endswith(" 1")


async def list_visible(conn: asyncpg.Connection) -> list[dict]:
    rows = await conn.fetch(
        """
        SELECT id, make, model FROM known_models
        WHERE NOT hidden
        ORDER BY lower(make), lower(model)
        """
    )
    return [dict(r) for r in rows]


async def list_all(conn: asyncpg.Connection) -> list[dict]:
    rows = await conn.fetch(
        """
        SELECT id, make, model, source, hidden, created_by, created_at, updated_at,
               year, tire_type, capacity, fuel_type, color, dual_drive, cab
        FROM known_models
        ORDER BY lower(make), lower(model)
        """
    )
    return [dict(r) for r in rows]


class DuplicateEntry(Exception):
    """A rename would make two entries the same pair."""


async def update(
    conn: asyncpg.Connection,
    entry_id,
    *,
    make: str | None = None,
    model: str | None = None,
    hidden: bool | None = None,
) -> dict | None:
    """Rename and/or hide one entry. None when it does not exist."""
    current = await conn.fetchrow("SELECT make, model FROM known_models WHERE id = $1", entry_id)
    if current is None:
        return None
    new_make = tidy(make) if make is not None else current["make"]
    new_model = tidy(model) if model is not None else current["model"]
    if not new_make or not new_model:
        raise ValueError("Make and model may not be blank.")
    try:
        row = await conn.fetchrow(
            """
            UPDATE known_models
               SET make = $2, model = $3, match_key = $4,
                   hidden = COALESCE($5, hidden), updated_at = now()
             WHERE id = $1
         RETURNING id, make, model, source, hidden, created_by, created_at, updated_at,
                   year, tire_type, capacity, fuel_type, color, dual_drive, cab
            """,
            entry_id, new_make, new_model, match_key(new_make, new_model), hidden,
        )
    except asyncpg.UniqueViolationError as exc:
        raise DuplicateEntry(f"{new_make} {new_model} is already in the list.") from exc
    return dict(row) if row else None
