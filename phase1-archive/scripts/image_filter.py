"""
image_filter.py
CleanShot Pipeline — Step 2
Quality filtering pipeline. Reads folder_index.json, scans every image in
every included folder, and produces a pass/reject list based on resolution,
file size, blur score, aspect ratio, and perceptual hash deduplication.

Usage:
    python scripts/image_filter.py

Inputs:
    output/folder_index.json   — produced by folder_parser.py

Outputs:
    output/filter_pass.json    — images that passed all checks, ready for captioning
    output/filter_reject.json  — images that failed with reasons
    output/filter_summary.json — per-folder stats and overall counts
"""

import os
import json
import struct
import zlib
from pathlib import Path
from collections import defaultdict
from dotenv import load_dotenv

load_dotenv()

# ── PILLOW DECOMPRESSION BOMB LIMIT ──────────────────────────────────────────
# Some large format images exceed Pillow's default safety limit.
# We increase it here since we trust our own dataset source.
try:
    from PIL import Image as _PILImage
    _PILImage.MAX_IMAGE_PIXELS = 300_000_000  # 300MP — handles very large TIFFs
except Exception:
    pass

# ── CONFIG ────────────────────────────────────────────────────────────────────
ROOT_DIR      = Path(os.getenv("ROOT_IMAGE_DIR",    "D:/100kb Salesman Images"))
INDEX_PATH    = Path(os.getenv("FOLDER_INDEX_PATH", "./output/folder_index.json"))
PASS_PATH     = Path("./output/filter_pass.json")
REJECT_PATH   = Path("./output/filter_reject.json")
SUMMARY_PATH  = Path("./output/filter_summary.json")

# ── FILTER THRESHOLDS ─────────────────────────────────────────────────────────
MIN_RESOLUTION   = 512          # minimum width AND height in pixels
MIN_FILE_SIZE    = 20_000       # bytes — reject anything under 20KB
MAX_ASPECT_RATIO = 5.0          # reject if width/height or height/width > 5
BLUR_THRESHOLD   = 80.0         # Laplacian variance below this = flagged blurry
HASH_DISTANCE    = 8            # perceptual hash hamming distance for duplicates

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


# ── LAZY IMPORTS ──────────────────────────────────────────────────────────────
# Imported inside functions so missing packages give clear error messages

def _pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        raise ImportError("Pillow not installed. Run: pip install pillow")

def _cv2():
    try:
        import cv2
        return cv2
    except ImportError:
        raise ImportError("OpenCV not installed. Run: pip install opencv-python")

def _imagehash():
    try:
        import imagehash
        return imagehash
    except ImportError:
        raise ImportError("imagehash not installed. Run: pip install imagehash")

def _numpy():
    try:
        import numpy as np
        return np
    except ImportError:
        raise ImportError("numpy not installed. Run: pip install numpy")


# ── IMAGE CHECKS ──────────────────────────────────────────────────────────────

def check_file_size(path: Path) -> tuple[bool, str | None]:
    """Reject images under MIN_FILE_SIZE bytes."""
    size = path.stat().st_size
    if size < MIN_FILE_SIZE:
        return False, f"file_too_small: {size:,} bytes (min {MIN_FILE_SIZE:,})"
    return True, None


def check_image_valid(path: Path) -> tuple[bool, str | None, object | None]:
    """
    Try to open the image with Pillow.
    Returns (ok, error_reason, pil_image).
    """
    Image = _pil()
    try:
        img = Image.open(path)
        img.verify()          # catches truncated files
        img = Image.open(path) # re-open after verify (verify closes the file)
        img.load()             # force full decode
        return True, None, img
    except Exception as e:
        return False, f"corrupt_image: {str(e)[:120]}", None


def check_resolution(img) -> tuple[bool, str | None]:
    """Reject images below MIN_RESOLUTION on either dimension."""
    w, h = img.size
    if w < MIN_RESOLUTION or h < MIN_RESOLUTION:
        return False, f"low_resolution: {w}x{h} (min {MIN_RESOLUTION}px each side)"
    return True, None


def check_aspect_ratio(img) -> tuple[bool, str | None]:
    """Reject images with extreme aspect ratios."""
    w, h = img.size
    ratio = max(w, h) / min(w, h)
    if ratio > MAX_ASPECT_RATIO:
        return False, f"extreme_aspect_ratio: {ratio:.1f}:1 (max {MAX_ASPECT_RATIO}:1)"
    return True, None


def check_blur(path: Path) -> tuple[bool, str | None, float]:
    """
    Compute Laplacian variance as blur score.
    Low variance = blurry image. Returns (ok, reason, score).
    ok is True even for blurry images — blur is a flag not a hard reject.
    """
    cv2 = _cv2()
    np  = _numpy()
    try:
        # Read with OpenCV — handles most formats
        img_bgr = cv2.imdecode(
            np.fromfile(str(path), dtype=np.uint8),
            cv2.IMREAD_GRAYSCALE
        )
        if img_bgr is None:
            return True, None, -1.0  # couldn't compute, don't reject

        score = float(cv2.Laplacian(img_bgr, cv2.CV_64F).var())
        if score < BLUR_THRESHOLD:
            return True, f"blurry: laplacian_variance={score:.1f} (threshold {BLUR_THRESHOLD})", score
        return True, None, score
    except Exception:
        return True, None, -1.0  # blur check failure is non-fatal


def compute_phash(path: Path):
    """
    Compute perceptual hash for duplicate detection.
    Returns hash object or None on failure.
    """
    imagehash = _imagehash()
    Image     = _pil()
    try:
        img = Image.open(path).convert("RGB")
        return imagehash.phash(img)
    except Exception:
        return None


# ── DEDUPLICATION ─────────────────────────────────────────────────────────────

def deduplicate_within_folder(candidates: list[dict]) -> list[dict]:
    """
    Within a single folder, mark near-duplicate images as rejected.
    Keeps the largest file when duplicates are found.
    Uses perceptual hash with HASH_DISTANCE threshold.

    candidates: list of dicts with keys: path, file_size, phash
    Returns candidates with 'duplicate_of' set on rejected ones.
    """
    imagehash = _imagehash()

    # Sort by file size descending — keep the largest (best quality) version
    candidates_sorted = sorted(candidates, key=lambda x: x["file_size"], reverse=True)

    kept   = []
    marked = set()

    for i, cand in enumerate(candidates_sorted):
        if cand["path"] in marked:
            continue
        if cand["phash"] is None:
            kept.append(cand)
            continue

        is_dup = False
        for keeper in kept:
            if keeper["phash"] is None:
                continue
            try:
                distance = cand["phash"] - keeper["phash"]
                if distance <= HASH_DISTANCE:
                    cand["duplicate_of"] = keeper["path"]
                    cand["hash_distance"] = distance
                    marked.add(cand["path"])
                    is_dup = True
                    break
            except Exception:
                continue

        if not is_dup:
            kept.append(cand)

    return candidates_sorted


# ── MAIN FILTER LOOP ──────────────────────────────────────────────────────────

def filter_folder(folder_entry: dict) -> tuple[list, list]:
    """
    Run all quality checks on every image in a single folder.
    Returns (pass_list, reject_list).
    Each item is a dict with image path, metadata, and check results.
    """
    folder_path = Path(folder_entry["folder_path"])
    metadata    = {
        k: folder_entry.get(k)
        for k in ("make", "year", "model", "tire_type", "capacity",
                  "fuel_type", "cab", "version", "raw_folder",
                  "is_latest_version", "superseded_by")
    }

    if not folder_path.exists():
        return [], []

    # Collect all image files
    image_files = [
        f for f in folder_path.iterdir()
        if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS
    ]

    if not image_files:
        return [], []

    candidates  = []  # images that pass hard checks, pending dedup
    hard_rejects = []  # images that fail hard checks

    for img_path in image_files:
        reject_reasons = []
        flags          = []
        blur_score     = -1.0

        # ── Hard reject checks ─────────────────────────────────────────────
        ok, reason = check_file_size(img_path)
        if not ok:
            hard_rejects.append({
                "path":           str(img_path),
                "filename":       img_path.name,
                "folder":         str(folder_path),
                "metadata":       metadata,
                "status":         "rejected",
                "reject_reasons": [reason],
                "flags":          [],
                "blur_score":     -1.0,
                "file_size":      img_path.stat().st_size,
            })
            continue

        ok, reason, pil_img = check_image_valid(img_path)
        if not ok:
            hard_rejects.append({
                "path":           str(img_path),
                "filename":       img_path.name,
                "folder":         str(folder_path),
                "metadata":       metadata,
                "status":         "rejected",
                "reject_reasons": [reason],
                "flags":          [],
                "blur_score":     -1.0,
                "file_size":      img_path.stat().st_size,
            })
            continue

        ok, reason = check_resolution(pil_img)
        if not ok:
            reject_reasons.append(reason)

        ok, reason = check_aspect_ratio(pil_img)
        if not ok:
            reject_reasons.append(reason)

        if reject_reasons:
            hard_rejects.append({
                "path":           str(img_path),
                "filename":       img_path.name,
                "folder":         str(folder_path),
                "metadata":       metadata,
                "status":         "rejected",
                "reject_reasons": reject_reasons,
                "flags":          [],
                "blur_score":     -1.0,
                "file_size":      img_path.stat().st_size,
            })
            continue

        # ── Soft flag checks (don't reject, just note) ─────────────────────
        ok, flag, blur_score = check_blur(img_path)
        if flag:
            flags.append(flag)

        # ── Compute perceptual hash for dedup ──────────────────────────────
        phash = compute_phash(img_path)

        candidates.append({
            "path":           str(img_path),
            "filename":       img_path.name,
            "folder":         str(folder_path),
            "metadata":       metadata,
            "status":         "pass",
            "reject_reasons": [],
            "flags":          flags,
            "blur_score":     round(blur_score, 2),
            "file_size":      img_path.stat().st_size,
            "phash":          phash,
            "duplicate_of":   None,
            "hash_distance":  None,
        })

    # ── Deduplicate within folder ──────────────────────────────────────────
    if candidates:
        candidates = deduplicate_within_folder(candidates)

    # Split candidates into pass and duplicate-reject
    pass_list   = []
    reject_list = list(hard_rejects)

    for cand in candidates:
        # Remove non-serializable phash object before saving
        phash_obj = cand.pop("phash", None)
        cand["phash_hex"] = str(phash_obj) if phash_obj else None

        if cand.get("duplicate_of"):
            cand["status"]         = "rejected"
            cand["reject_reasons"] = [f"duplicate: hash_distance={cand.get('hash_distance', '?')} from {cand['duplicate_of']}"]
            reject_list.append(cand)
        else:
            pass_list.append(cand)

    return pass_list, reject_list


def run_filter(index: list) -> tuple[list, list, dict]:
    """
    Run filter across all folders in the index.
    Returns (all_pass, all_reject, summary).
    """
    all_pass   = []
    all_reject = []
    summary    = {
        "total_folders":   len(index),
        "total_images":    0,
        "passed":          0,
        "rejected":        0,
        "hard_rejected":   0,
        "duplicates":      0,
        "blurry_flagged":  0,
        "per_make":        defaultdict(lambda: {"pass": 0, "reject": 0}),
    }

    # Skip folders superseded by a newer version
    active_folders = [
        e for e in index
        if e.get("is_latest_version") is not False
    ]

    superseded_count = len(index) - len(active_folders)
    summary["superseded_folders_skipped"] = superseded_count

    print(f"  Active folders to filter: {len(active_folders)}")
    print(f"  Superseded folders skipped: {superseded_count}")
    print()

    for i, entry in enumerate(active_folders):
        folder_name = entry.get("raw_folder", "unknown")
        make        = entry.get("make", "unknown")

        if (i + 1) % 50 == 0 or i == 0:
            print(f"  [{i+1}/{len(active_folders)}] Processing {make}...")

        pass_list, reject_list = filter_folder(entry)

        all_pass.extend(pass_list)
        all_reject.extend(reject_list)

        folder_total = len(pass_list) + len(reject_list)
        summary["total_images"]   += folder_total
        summary["passed"]         += len(pass_list)
        summary["rejected"]       += len(reject_list)
        summary["per_make"][make]["pass"]   += len(pass_list)
        summary["per_make"][make]["reject"] += len(reject_list)

        for r in reject_list:
            reasons = r.get("reject_reasons", [])
            if any("duplicate" in reason for reason in reasons):
                summary["duplicates"] += 1
            else:
                summary["hard_rejected"] += 1

        for p in pass_list:
            if p.get("flags"):
                summary["blurry_flagged"] += 1

    summary["per_make"] = dict(summary["per_make"])
    return all_pass, all_reject, summary


class _SafeEncoder(json.JSONEncoder):
    """Handles numpy int64 and other non-standard numeric types from imagehash."""
    def default(self, obj):
        try:
            import numpy as np
            if isinstance(obj, (np.integer,)):
                return int(obj)
            if isinstance(obj, (np.floating,)):
                return float(obj)
        except ImportError:
            pass
        if hasattr(obj, 'item'):   # numpy scalar fallback
            return obj.item()
        return super().default(obj)


def write_outputs(pass_list: list, reject_list: list, summary: dict):
    """Write all three output files."""
    PASS_PATH.parent.mkdir(parents=True, exist_ok=True)

    with open(PASS_PATH, "w", encoding="utf-8") as f:
        json.dump(pass_list, f, indent=2, ensure_ascii=False, cls=_SafeEncoder)

    with open(REJECT_PATH, "w", encoding="utf-8") as f:
        json.dump(reject_list, f, indent=2, ensure_ascii=False, cls=_SafeEncoder)

    with open(SUMMARY_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False, cls=_SafeEncoder)

    print(f"\nOutputs written:")
    print(f"  filter_pass.json    -> {PASS_PATH}    ({len(pass_list):,} images)")
    print(f"  filter_reject.json  -> {REJECT_PATH}  ({len(reject_list):,} images)")
    print(f"  filter_summary.json -> {SUMMARY_PATH}")


def print_summary(summary: dict, pass_list: list, reject_list: list):
    """Print human-readable summary to terminal."""
    total      = summary["total_images"]
    passed     = summary["passed"]
    rejected   = summary["rejected"]
    hard_rej   = summary["hard_rejected"]
    dupes      = summary["duplicates"]
    blurry     = summary["blurry_flagged"]
    superseded = summary.get("superseded_folders_skipped", 0)

    pass_pct   = (passed / total * 100) if total > 0 else 0
    reject_pct = (rejected / total * 100) if total > 0 else 0

    print("\n" + "="*60)
    print("IMAGE FILTER SUMMARY")
    print("="*60)
    print(f"Total images scanned:      {total:,}")
    print(f"Passed:                    {passed:,}  ({pass_pct:.1f}%)")
    print(f"Rejected:                  {rejected:,}  ({reject_pct:.1f}%)")
    print(f"  - Hard rejected:         {hard_rej:,}")
    print(f"  - Duplicates removed:    {dupes:,}")
    print(f"Blurry (flagged, not rej): {blurry:,}")
    print(f"Superseded folders skip:   {superseded:,}")
    print()

    # Rejection reason breakdown
    from collections import Counter
    reason_counts = Counter()
    for r in reject_list:
        for reason in r.get("reject_reasons", []):
            key = reason.split(":")[0]
            reason_counts[key] += 1

    if reason_counts:
        print("Rejection reasons:")
        for reason, count in reason_counts.most_common():
            print(f"  {reason:<35} {count:,}")
        print()

    # Top 10 makes by pass count
    per_make = summary.get("per_make", {})
    print("Top 10 makes by images passed:")
    sorted_makes = sorted(per_make.items(), key=lambda x: -x[1]["pass"])
    for make, counts in sorted_makes[:10]:
        total_make = counts["pass"] + counts["reject"]
        pct = (counts["pass"] / total_make * 100) if total_make > 0 else 0
        print(f"  {make:<30} {counts['pass']:>5} pass  {counts['reject']:>5} reject  ({pct:.0f}%)")

    print("="*60)

    if passed < 500:
        print(f"\n⚠️  WARNING: Only {passed:,} images passed. Minimum recommended is 500.")
        print("   Consider lowering filter thresholds or sourcing more images.")
    elif passed < 2000:
        print(f"\n⚠️  NOTE: {passed:,} images passed — good for basic tuning.")
        print("   2,000+ is recommended for strong commercial quality results.")
    else:
        print(f"\n✅ {passed:,} images ready for captioning — strong dataset size.")


# ── DEPENDENCY CHECK ──────────────────────────────────────────────────────────

def check_dependencies():
    """Verify all required packages are installed before running."""
    missing = []
    for pkg, name in [
        ("PIL",       "pillow"),
        ("cv2",       "opencv-python"),
        ("imagehash", "imagehash"),
        ("numpy",     "numpy"),
    ]:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(name)

    if missing:
        print("ERROR: Missing required packages:")
        for pkg in missing:
            print(f"  pip install {pkg}")
        return False
    return True


# ── MAIN ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    print("CleanShot Pipeline — Step 2: Image Quality Filter")
    print("="*60)

    if not check_dependencies():
        sys.exit(1)

    # Load folder index
    if not INDEX_PATH.exists():
        print(f"ERROR: folder_index.json not found at {INDEX_PATH}")
        print("Run folder_parser.py first.")
        sys.exit(1)

    print(f"Loading folder index from {INDEX_PATH}...")
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        index = json.load(f)

    # Only process folders that were not excluded (have a year)
    active = [e for e in index if e.get("year") is not None]
    print(f"Loaded {len(index):,} total folders, {len(active):,} eligible for filtering.\n")

    if not active:
        print("No eligible folders found. Check folder_index.json.")
        sys.exit(1)

    print("Starting image quality filter...")
    print(f"Thresholds:")
    print(f"  Min resolution:   {MIN_RESOLUTION}x{MIN_RESOLUTION}px")
    print(f"  Min file size:    {MIN_FILE_SIZE:,} bytes ({MIN_FILE_SIZE//1000}KB)")
    print(f"  Max aspect ratio: {MAX_ASPECT_RATIO}:1")
    print(f"  Blur threshold:   {BLUR_THRESHOLD} (Laplacian variance)")
    print(f"  Hash distance:    {HASH_DISTANCE} (perceptual hash)")
    print()

    pass_list, reject_list, summary = run_filter(active)

    write_outputs(pass_list, reject_list, summary)
    print_summary(summary, pass_list, reject_list)