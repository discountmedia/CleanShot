"""
Build the Make / Model seed list from Stephen's forklift catalog (2 Oct 2026).

    python scripts/build_catalog_models.py [path/to/forklift_catalog.csv]

Reads forklift_catalog.csv (default: the repo root, where Stephen drops it) and
writes apps/api/src/cleanshot_api/data/known_models_catalog.csv with two
columns, Make and Model, one row per pair. The API seeds the Make / Model
dropdowns from that file on every start (services/known_models.py).

Why a slim copy and not the catalog itself: the catalog carries D: drive
paths and folder names, none of which the API needs, and the image ships only
src/. Keep forklift_catalog.csv OUT of git.

Models are written with spaces, not underscores: the catalog's parser turned
the folder's spaces into "_", and the export name turns them back into "_"
either way, so the dropdown can show the readable form.

Skipped on purpose (Stephen, 2 Oct: "skip the obvious junk"), and printed so
the list can be checked:
  * makes that are not makes: "Un" (first word of the folder "Un Li-Ion and
    LP") and "Vegas Media" (a media folder, not a manufacturer);
  * rows the catalog itself flags as filed under the wrong make;
  * models that are a folder-name leftover rather than a model: a lone tire or
    fuel word, a tire letter or capacity glued onto the model, a customer name,
    or a trade-show / photo-shoot tag.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "forklift_catalog.csv"
TARGET = ROOT / "apps/api/src/cleanshot_api/data/known_models_catalog.csv"

NOT_A_MAKE = {"UN", "VEGAS MEDIA"}
NOT_A_MODEL = {"C", "P", "CUSHION", "DIESEL", "NO_MODEL"}
# A tire letter ("FD50_P"), "_NM", or a stray suffix glued on by a folder name
# that had no tire slot; a capacity written into the model ("4,000LB"); a
# customer, show or shoot tag.
LEFTOVER = re.compile(
    r"(_[PC]|_NM|_CAB|_STANDARD|_DOUBLE)$"
    r"|\d,\d{3}LB"
    r"|CRASHCHAMPIONS|MODEX"
    r"|^MP1F1A20LV_1141$",  # a stock number on the end of one Nissan folder
)


def key(s: str) -> str:
    return re.sub(r"\s+", "", s).upper()


def main() -> None:
    pairs: dict[str, tuple[str, str]] = {}
    skipped: dict[str, str] = {}
    with SOURCE.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            make = " ".join(row["Make"].split())
            model_raw = row["Model"].strip()
            if not make or not model_raw:
                continue
            label = f"{make} {model_raw}"
            if make.upper() in NOT_A_MAKE:
                skipped[label] = "not a make"
                continue
            if "name says make" in row["Warnings"]:
                skipped[label] = "filed under the wrong make"
                continue
            if model_raw.upper() in NOT_A_MODEL or LEFTOVER.search(model_raw.upper()):
                skipped[label] = "folder-name leftover"
                continue
            model = " ".join(model_raw.replace("_", " ").split())
            pairs.setdefault(f"{key(make)}|{key(model)}", (make, model))

    rows = sorted(pairs.values(), key=lambda p: (p[0].lower(), p[1].lower()))
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with TARGET.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Make", "Model"])
        w.writerows(rows)

    print(f"wrote {len(rows)} pairs, {len({k.split('|')[0] for k in pairs})} makes -> {TARGET.relative_to(ROOT)}")
    print(f"skipped {len(skipped)}:")
    for label, why in sorted(skipped.items()):
        print(f"  {label}  ({why})")


if __name__ == "__main__":
    main()
