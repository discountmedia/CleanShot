"""
folder_parser.py
CleanShot Pipeline — Step 1
Parses forklift folder names from D:/100kb Salesman Images into structured
metadata dicts. Outputs output/folder_index.json and output/anomaly_log.json.

Usage:
    python scripts/folder_parser.py

Outputs:
    output/folder_index.json   — full metadata for every parsed folder
    output/anomaly_log.json    — folders with parsing issues for review
"""

import os
import re
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ── CONFIG ────────────────────────────────────────────────────────────────────
ROOT_DIR    = Path(os.getenv("ROOT_IMAGE_DIR", "D:/100kb Salesman Images"))
INDEX_PATH  = Path(os.getenv("FOLDER_INDEX_PATH", "./output/folder_index.json"))
ANOMALY_LOG = Path(os.getenv("ANOMALY_LOG_PATH", "./output/anomaly_log.json"))

# ── FUEL TYPE NORMALIZATION ───────────────────────────────────────────────────
# Covers all variants found in the real dataset including voltage-spec electrics,
# full-word variants, and propane shorthand variants.
FUEL_MAP = {
    # Electric — standard abbreviations
    "E":        "Electric",
    "4WE":      "Electric",
    "3WE":      "Electric",
    "4WE2":     "Electric",
    "48VLI":    "Electric",
    "80VLI":    "Electric",
    "96VLI":    "Electric",
    # Electric — voltage spec variants found in real data
    "E12V":     "Electric",
    "E24V":     "Electric",
    "E36V":     "Electric",
    "E36VA":    "Electric",
    "E48V":     "Electric",
    "E80V":     "Electric",
    "E96V":     "Electric",
    "E110V":    "Electric",
    "E208V":    "Electric",
    "24V":      "Electric",
    "36V":      "Electric",
    "48V":      "Electric",
    "80V":      "Electric",
    "80VL":     "Electric",
    "80VLI2":   "Electric",
    "96V":      "Electric",
    # Electric — lithium ion variants
    "LI":       "Electric",
    "LIION":    "Electric",
    "ELIION":   "Electric",
    "ELECTRIC": "Electric",
    # Electric — Crown standup rider / walkie / pallet jack codes
    "SUR":      "Electric",
    "SUD":      "Electric",
    "SUER":     "Electric",
    "SUE":      "Electric",
    "WSR":      "Electric",
    "WS":       "Electric",
    "WSC":      "Electric",
    "WSS":      "Electric",
    "EPJ":      "Electric",
    "EOP":      "Electric",
    "EWS":      "Electric",
    "MPS":      "Electric",
    "MPJ":      "Electric",
    "OP":       "Electric",
    # Electric — Crown narrow aisle reach codes
    "NAR":      "Electric",
    "RNA":      "Electric",
    "NADR":     "Electric",
    # Liquid Propane — all shorthand variants
    "LP":       "Liquid Propane",
    "LPG":      "Liquid Propane",
    "LPGAS":    "Liquid Propane",
    # Gasoline
    "G":        "Gasoline",
    "GAS":      "Gasoline",
    "GASOLINE": "Gasoline",
    # Diesel
    "D":        "Diesel",
    "DD":       "Diesel",
    "DIESEL":   "Diesel",
    # Dual Fuel
    "DUAL":     "Dual Fuel",
}

# ── COLOR WORDS TO DISCARD SILENTLY ──────────────────────────────────────────
COLOR_WORDS = {
    "LUMINOUS", "LUMIYEL", "RED", "BLUE", "GREEN", "WHITE", "BLACK",
    "YELLOW", "ORANGE", "SILVER", "GRAY", "GREY", "PURPLE", "BROWN",
    "GOLD", "STANDARD",
}

# ── TOKENS TO DISCARD AND LOG ─────────────────────────────────────────────────
DISCARD_TOKENS = {
    "CRASHCHAMPIONS", "LOGO", "NO", "COPY",
    # Lift Hero folder annotation tokens — safe to discard silently
    "UPDATED", "SET", "OF", "ALL", "COLORS",
}

# ── TIRE TYPE MAP ─────────────────────────────────────────────────────────────
# Extended to cover non-standard equipment found in the real dataset
TIRE_MAP = {
    "C":   "Cushion",
    "P":   "Pneumatic",
    "PN":  "Pneumatic",
    "RT":  "Rough Terrain",
    "SS":  "Skid Steer",
    "T":   "Tracks",
    "SD":  "Sit-Down",
    "4WD": "Four Wheel Drive",
}


def parse_capacity(raw: str) -> str | None:
    """
    Convert capacity token to human-readable string.
    Handles K notation, T (ton), and raw numeric lb values.
    """
    raw = raw.upper()
    if raw.endswith("K"):
        try:
            lbs = int(float(raw[:-1]) * 1000)
            return f"{lbs:,} lbs"
        except ValueError:
            return None
    if raw.endswith("T"):
        try:
            return f"{float(raw[:-1])} ton"
        except ValueError:
            return None
    if re.match(r'^\d+$', raw):
        return f"{int(raw):,} lbs"
    return None


def is_tire_capacity_token(token: str) -> tuple[str | None, str | None]:
    """
    Detect a TireType-Capacity token like C-3K, P-8.5K, RT-4K, SS-3.2K.
    Returns (tire_code, capacity_raw) or (None, None).
    """
    token_upper = token.upper()
    # Pattern: one or more letters (with optional digits) then hyphen then capacity
    match = re.match(r'^([A-Z]+\d*[A-Z]*)-(\d+(?:\.\d+)?[KT]|\d+)$', token_upper)
    if match:
        tire_code = match.group(1)
        cap_raw   = match.group(2)
        if tire_code in TIRE_MAP or re.match(r'^[CP]$', tire_code):
            return tire_code, cap_raw
    return None, None


def normalize_folder_name(folder_name: str) -> str:
    """
    Normalize folder name before parsing:
    - Replace spaces with underscores
    - Remove parentheses
    - Strip whitespace
    """
    name = folder_name.strip()
    name = name.replace(" ", "_")
    name = name.replace("(", "").replace(")", "")
    return name


def parse_folder_name(folder_name: str, make_from_parent: str) -> dict:
    """
    Parse a forklift folder name into structured metadata.

    Naming convention:
        MAKE_YEAR_MODEL_TIRETYPE-CAPACITY_FUELTYPE[_EXTRA]

    The Make is always taken from the parent folder name.
    Everything between Year and the TireType-Capacity token is the Model.
    """
    result = {
        "make":       make_from_parent,
        "year":       None,
        "model":      None,
        "tire_type":  None,
        "capacity":   None,
        "fuel_type":  None,
        "cab":        False,
        "version":    None,
        "anomalies":  [],
        "raw_folder": folder_name,
    }

    normalized = normalize_folder_name(folder_name)
    tokens = normalized.split("_")

    # ── SKIP PLACEHOLDER FOLDERS ──────────────────────────────────────────────
    skip_markers = {"TBD", "TESTBACKUPFOLDER", "UNKNOWN"}
    if any(t.upper() in skip_markers for t in tokens):
        result["anomalies"].append("skipped: folder contains placeholder marker (TBD/test/unknown)")
        return result

    # ── FIND YEAR ─────────────────────────────────────────────────────────────
    year_index = None
    for i, token in enumerate(tokens):
        if re.match(r'^(19[5-9]\d|20[0-3]\d)$', token):
            result["year"] = token
            year_index = i
            break

    if year_index is None:
        result["anomalies"].append("missing_year: no 4-digit year found in folder name")
        return result

    # ── FIND TIRE-CAPACITY TOKEN ───────────────────────────────────────────────
    tire_index = None
    for i in range(year_index + 1, len(tokens)):
        tire_code, cap_raw = is_tire_capacity_token(tokens[i])
        if tire_code:
            result["tire_type"] = TIRE_MAP.get(tire_code, tire_code)
            result["capacity"]  = parse_capacity(cap_raw)
            tire_index = i
            break

    if tire_index is None:
        result["anomalies"].append("missing_tire_capacity: no TireType-Capacity token found")
        return result

    # ── EXTRACT MODEL ─────────────────────────────────────────────────────────
    model_tokens = tokens[year_index + 1 : tire_index]

    # Strip leading make token if repeated
    if model_tokens and model_tokens[0].upper().replace(" ", "_") == make_from_parent.upper().replace(" ", "_"):
        model_tokens = model_tokens[1:]

    result["model"] = " ".join(model_tokens).strip() if model_tokens else None

    if not result["model"]:
        result["anomalies"].append("missing_model: no model tokens found between year and tire segment")

    # ── EXTRACT FUEL TYPE AND TRAILING TOKENS ─────────────────────────────────
    trailing_tokens = tokens[tire_index + 1:]
    fuel_found = False

    for token in trailing_tokens:
        token_upper = token.upper()

        # Version number — bare integer is always version, never fuel
        if re.match(r'^\d+$', token):
            result["version"] = int(token)
            continue

        # Cab flag
        if token_upper == "CAB":
            result["cab"] = True
            continue

        # Silent color discard
        if token_upper in COLOR_WORDS:
            continue

        # Known erroneous tokens — log and discard
        if token_upper in DISCARD_TOKENS:
            result["anomalies"].append(f"discarded_token: '{token}' — known erroneous token")
            continue

        # Fuel lookup — handles plain tokens, stripped compound tokens,
        # and prefix-split tokens (e.g. LP-yellow -> LP, E48V-yellow -> E48V)
        if not fuel_found:
            # Try exact match first
            if token_upper in FUEL_MAP:
                result["fuel_type"] = FUEL_MAP[token_upper]
                fuel_found = True
            else:
                # Strip hyphens/plus and retry (LP-Gas -> LPGAS)
                normalized_upper = re.sub(r'[-+]', '', token_upper)
                if normalized_upper in FUEL_MAP:
                    result["fuel_type"] = FUEL_MAP[normalized_upper]
                    fuel_found = True
                else:
                    # Split on first hyphen and check prefix (LP-yellow -> LP)
                    prefix = token_upper.split('-')[0]
                    if prefix in FUEL_MAP:
                        result["fuel_type"] = FUEL_MAP[prefix]
                        fuel_found = True
                    else:
                        result["anomalies"].append(f"unknown_fuel_token: '{token}' not in fuel normalization table")
            continue

        # Post-fuel unrecognized token
        result["anomalies"].append(f"discarded_token: '{token}' — unrecognized trailing token")

    if not fuel_found:
        result["anomalies"].append("missing_fuel: no fuel type token found after tire-capacity segment")

    return result


def parse_all_folders(root_dir: Path) -> tuple[list, list]:
    """
    Walk the root directory tree and parse every subfolder.
    """
    index     = []
    anomalies = []

    if not root_dir.exists():
        print(f"ERROR: ROOT_IMAGE_DIR does not exist: {root_dir}")
        print("Check that the D: drive is mounted and the path is correct.")
        return index, anomalies

    make_folders = sorted([f for f in root_dir.iterdir() if f.is_dir()])

    if not make_folders:
        print(f"WARNING: No subfolders found in {root_dir}")
        return index, anomalies

    print(f"Found {len(make_folders)} make folders in {root_dir}")

    for make_folder in make_folders:
        make_name = make_folder.name

        # Skip hidden/system folders
        if make_name.startswith("."):
            print(f"  Skipping system folder: {make_name}")
            continue

        print(f"  Parsing make: {make_name}")
        sub_folders = sorted([f for f in make_folder.iterdir() if f.is_dir()])

        for sub_folder in sub_folders:
            parsed = parse_folder_name(sub_folder.name, make_name)

            # Exclude folders with no year — attachments, accessories,
            # placeholders, and non-standard equipment without a year
            if parsed["year"] is None:
                anomalies.append({
                    "folder":    sub_folder.name,
                    "path":      str(sub_folder),
                    "make":      make_name,
                    "anomalies": parsed["anomalies"],
                    "excluded":  True,
                    "exclude_reason": "missing_year",
                    "parsed":    {
                        k: v for k, v in parsed.items()
                        if k not in ("anomalies", "folder_path", "make_folder")
                    }
                })
                continue

            image_extensions = {".jpg", ".jpeg", ".png", ".webp"}
            images = [
                f for f in sub_folder.iterdir()
                if f.is_file() and f.suffix.lower() in image_extensions
            ]
            parsed["image_count"] = len(images)
            parsed["folder_path"] = str(sub_folder)
            parsed["make_folder"] = make_name

            index.append(parsed)

            if parsed["anomalies"]:
                anomalies.append({
                    "folder":    sub_folder.name,
                    "path":      str(sub_folder),
                    "make":      make_name,
                    "anomalies": parsed["anomalies"],
                    "excluded":  False,
                    "parsed":    {
                        k: v for k, v in parsed.items()
                        if k not in ("anomalies", "folder_path", "make_folder")
                    }
                })

    return index, anomalies


def flag_version_duplicates(index: list) -> list:
    """
    Flag lower-versioned folders as superseded by the highest-versioned
    folder for the same forklift (matched on make+model+tire+capacity+fuel).
    """
    from collections import defaultdict

    groups = defaultdict(list)
    for entry in index:
        key = (
            (entry.get("make")      or "").lower(),
            (entry.get("model")     or "").lower(),
            (entry.get("tire_type") or "").lower(),
            (entry.get("capacity")  or "").lower(),
            (entry.get("fuel_type") or "").lower(),
        )
        groups[key].append(entry)

    for key, entries in groups.items():
        if len(entries) > 1:
            entries.sort(key=lambda e: e.get("version") or 0, reverse=True)
            entries[0]["is_latest_version"] = True
            for e in entries[1:]:
                e["is_latest_version"] = False
                e["superseded_by"] = entries[0]["raw_folder"]

    return index


def write_outputs(index: list, anomalies: list):
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)

    with open(ANOMALY_LOG, "w", encoding="utf-8") as f:
        json.dump(anomalies, f, indent=2, ensure_ascii=False)

    print(f"\nResults written:")
    print(f"  folder_index.json  -> {INDEX_PATH}  ({len(index)} folders)")
    print(f"  anomaly_log.json   -> {ANOMALY_LOG}  ({len(anomalies)} anomalies)")


def print_summary(index: list, anomalies: list):
    total          = len(index)
    clean          = sum(1 for e in index if not e["anomalies"])
    excluded       = sum(1 for e in anomalies if e.get("excluded"))
    with_anomalies = sum(1 for e in anomalies if not e.get("excluded"))
    no_images      = sum(1 for e in index if e["image_count"] == 0)
    total_images   = sum(e["image_count"] for e in index)
    versioned      = sum(1 for e in index if e.get("version") is not None)
    superseded     = sum(1 for e in index if e.get("is_latest_version") is False)

    fuel_counts = {}
    for e in index:
        fuel = e.get("fuel_type") or "Unknown"
        fuel_counts[fuel] = fuel_counts.get(fuel, 0) + 1

    make_counts = {}
    for e in index:
        make = e.get("make") or "Unknown"
        make_counts[make] = make_counts.get(make, 0) + 1

    print("\n" + "="*60)
    print("FOLDER PARSER SUMMARY")
    print("="*60)
    print(f"Total folders parsed:      {total}")
    print(f"Folders clean (no errors): {clean}")
    print(f"Folders with anomalies:    {with_anomalies}")
    print(f"Folders excluded (no year):{excluded}")
    print(f"Folders with no images:    {no_images}")
    print(f"Total images found:        {total_images:,}")
    print(f"Versioned folders:         {versioned}")
    print(f"Superseded (older ver):    {superseded}")
    print()
    print("Fuel Type Distribution:")
    for fuel, count in sorted(fuel_counts.items(), key=lambda x: -x[1]):
        print(f"  {fuel:<25} {count}")
    print()
    print("Make Distribution (top 20):")
    for make, count in sorted(make_counts.items(), key=lambda x: -x[1])[:20]:
        print(f"  {make:<35} {count}")
    print("="*60)

    if excluded > 0:
        print(f"\n🚫 {excluded} folders excluded (missing year) — logged in anomaly_log.json.")
    if with_anomalies > 0:
        print(f"\n⚠️  {with_anomalies} folders have anomalies.")
        print(f"   Review output/anomaly_log.json before proceeding.")
        high_priority = [a for a in anomalies if not a.get("excluded") and len(a["anomalies"]) >= 3]
        if high_priority:
            print(f"   {len(high_priority)} folders have 3+ anomaly flags — manual review required.")


# ── SELF-TEST ─────────────────────────────────────────────────────────────────
def run_self_tests():
    """
    Validate parser against all playbook examples plus real-world edge cases
    discovered in the actual dataset.
    """
    print("Running self-tests...")

    tests = [
        # ── Original playbook examples ────────────────────────────────────────
        {
            "folder": "Hyster_2017_E30XN_C-3K_E",
            "make":   "Hyster",
            "expected": {
                "year": "2017", "model": "E30XN",
                "tire_type": "Cushion", "capacity": "3,000 lbs",
                "fuel_type": "Electric", "cab": False, "version": None,
            }
        },
        {
            "folder": "Lift_Hero_2023_CPD38_P-8.5K_4WE_Cab",
            "make":   "Lift Hero",
            "expected": {
                "year": "2023", "model": "CPD38",
                "tire_type": "Pneumatic", "capacity": "8,500 lbs",
                "fuel_type": "Electric", "cab": True, "version": None,
            }
        },
        {
            "folder": "Lift_Hero_2024_CDD15-EIC2_MODEX_C-3.3K_E12V",
            "make":   "Lift Hero",
            "expected": {
                "year": "2024", "model": "CDD15-EIC2 MODEX",
                "tire_type": "Cushion", "capacity": "3,300 lbs",
                "fuel_type": "Electric", "cab": False, "version": None,
            }
        },
        {
            "folder": "Lift_Hero_2023_CPD30_P-6K_CRASHCHAMPIONS_E",
            "make":   "Lift Hero",
            "expected": {
                "year": "2023", "model": "CPD30",
                "tire_type": "Pneumatic", "capacity": "6,000 lbs",
                "fuel_type": "Electric", "cab": False, "version": None,
            }
        },
        {
            "folder": "Lift_Hero_2023_CPD30_P-6K_E_2",
            "make":   "Lift Hero",
            "expected": {
                "year": "2023", "model": "CPD30",
                "tire_type": "Pneumatic", "capacity": "6,000 lbs",
                "fuel_type": "Electric", "cab": False, "version": 2,
            }
        },
        {
            "folder": "Lift_Hero_2024_LG30GLT_P-6K_LP_Luminous",
            "make":   "Lift Hero",
            "expected": {
                "year": "2024", "model": "LG30GLT",
                "tire_type": "Pneumatic", "capacity": "6,000 lbs",
                "fuel_type": "Liquid Propane", "cab": False, "version": None,
            }
        },
        # ── Real dataset edge cases ───────────────────────────────────────────
        {
            "folder": "Caterpillar_1992_F30_C-3K_E36V_2",
            "make":   "Caterpillar",
            "expected": {
                "year": "1992", "model": "F30",
                "tire_type": "Cushion", "capacity": "3,000 lbs",
                "fuel_type": "Electric", "cab": False, "version": 2,
            }
        },
        {
            "folder": "Clark_1994_NP30_C-3K_E24V_2",
            "make":   "Clark",
            "expected": {
                "year": "1994", "model": "NP30",
                "tire_type": "Cushion", "capacity": "3,000 lbs",
                "fuel_type": "Electric", "cab": False, "version": 2,
            }
        },
        {
            "folder": "Toyota_2019_8FGU25_P-5K_LPG",
            "make":   "Toyota",
            "expected": {
                "year": "2019", "model": "8FGU25",
                "tire_type": "Pneumatic", "capacity": "5,000 lbs",
                "fuel_type": "Liquid Propane", "cab": False, "version": None,
            }
        },
        {
            "folder": "Hyster_2018_H80FT_P-8K_Diesel",
            "make":   "Hyster",
            "expected": {
                "year": "2018", "model": "H80FT",
                "tire_type": "Pneumatic", "capacity": "8,000 lbs",
                "fuel_type": "Diesel", "cab": False, "version": None,
            }
        },
        {
            "folder": "Crown_2003_RC3020_C-3K_E36V_2",
            "make":   "Crown",
            "expected": {
                "year": "2003", "model": "RC3020",
                "tire_type": "Cushion", "capacity": "3,000 lbs",
                "fuel_type": "Electric", "cab": False, "version": 2,
            }
        },
    ]

    passed = 0
    failed = 0

    for test in tests:
        result = parse_folder_name(test["folder"], test["make"])
        exp    = test["expected"]
        errors = []

        for field, expected_val in exp.items():
            actual_val = result.get(field)
            if actual_val != expected_val:
                errors.append(f"  {field}: expected '{expected_val}' got '{actual_val}'")

        if errors:
            print(f"  FAIL: {test['folder']}")
            for e in errors:
                print(e)
            failed += 1
        else:
            print(f"  PASS: {test['folder']}")
            passed += 1

    print(f"\nSelf-test results: {passed} passed, {failed} failed")

    if failed > 0:
        print("ERROR: Fix failing tests before running on real data.")
        return False

    print("All self-tests passed. Safe to run on real data.\n")
    return True


# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    if not run_self_tests():
        sys.exit(1)

    print(f"Starting folder parse...")
    print(f"Root directory: {ROOT_DIR}")
    print(f"Output index:   {INDEX_PATH}")
    print(f"Anomaly log:    {ANOMALY_LOG}\n")

    index, anomalies = parse_all_folders(ROOT_DIR)

    if not index:
        print("No folders were parsed. Check ROOT_IMAGE_DIR in your .env file.")
        sys.exit(1)

    index = flag_version_duplicates(index)

    write_outputs(index, anomalies)
    print_summary(index, anomalies)