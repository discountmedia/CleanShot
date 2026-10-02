"""
The known Make + Model list behind the Make and Model dropdowns (2 Oct 2026).

Settled with Stephen:

* **Seeded from the inventory CSV**, then grown by operators: a make and model
  typed through "Other" joins everyone's list when the project is saved.
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

import logging
import re

import asyncpg

from cleanshot_api.services.export_naming import default_inventory

logger = logging.getLogger(__name__)


def _key_part(value: str | None) -> str:
    return re.sub(r"\s+", "", value or "").upper()


def match_key(make: str | None, model: str | None) -> str:
    return f"{_key_part(make)}|{_key_part(model)}"


def tidy(value: str | None) -> str:
    """How a name is stored for display: trimmed, inner whitespace collapsed."""
    return " ".join((value or "").split())


async def seed_from_inventory(conn: asyncpg.Connection) -> int:
    """Insert every inventory pair not already present. Returns rows added.

    ON CONFLICT DO NOTHING is what keeps an admin's rename or hide: an existing
    row, hidden or not, is never touched by the seed.
    """
    pairs = default_inventory().pairs()
    added = 0
    for make, model in pairs:
        status = await conn.execute(
            """
            INSERT INTO known_models (make, model, match_key, source)
            VALUES ($1, $2, $3, 'inventory')
            ON CONFLICT (match_key) DO NOTHING
            """,
            tidy(make), tidy(model), match_key(make, model),
        )
        added += status.endswith(" 1")
    return added


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
