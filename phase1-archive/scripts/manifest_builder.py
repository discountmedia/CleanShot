"""
manifest_builder.py
CleanShot Pipeline — Step 4
Validates captions, standardizes images, uploads to GCS bucket
cleanshot-training-df-2026, and writes Vertex AI JSONL manifests.

Usage:
    python scripts/manifest_builder.py

Inputs:
    output/caption_cache.json  — produced by captioner.py
    output/filter_pass.json    — produced by image_filter.py

Outputs:
    output/manifests/training.jsonl    — 85% split for Vertex AI training
    output/manifests/validation.jsonl  — 15% split for Vertex AI validation
    output/manifests/upload_log.json   — record of every GCS upload
    output/manifests/rejected_captions.json — captions that failed validation
"""

import os
import sys
import json
import random
import shutil
import io
from pathlib import Path
from collections import defaultdict
from dotenv import load_dotenv

load_dotenv()

# ── CONFIG ────────────────────────────────────────────────────────────────────
CAPTION_CACHE   = Path("./output/caption_cache.json")
FILTER_PASS     = Path("./output/filter_pass.json")
MANIFEST_DIR    = Path("./output/manifests")
TRAINING_JSONL  = MANIFEST_DIR / "training.jsonl"
VALIDATION_JSONL= MANIFEST_DIR / "validation.jsonl"
UPLOAD_LOG      = MANIFEST_DIR / "upload_log.json"
REJECTED_PATH   = MANIFEST_DIR / "rejected_captions.json"

GCS_BUCKET      = os.getenv("GCS_BUCKET",     "cleanshot-training-df-2026")
GCP_PROJECT     = os.getenv("GCP_PROJECT_ID", "cleanshot-493512")
GCS_IMAGE_PREFIX= "images"

TRAIN_SPLIT     = 0.85          # 85% training, 15% validation
TARGET_SIZE     = 1024          # standardize images to 1024x1024px
JPEG_QUALITY    = 93
MIN_CAPTION_LEN = 30            # minimum words in caption
MIN_QUALITY     = 4             # minimum quality_score to include
RANDOM_SEED     = 42            # reproducible train/val split


# ── GCS CLIENT ────────────────────────────────────────────────────────────────
def get_gcs_client():
    try:
        from google.cloud import storage
        client = storage.Client(project=GCP_PROJECT)
        bucket = client.bucket(GCS_BUCKET)
        return client, bucket
    except ImportError:
        print("ERROR: google-cloud-storage not installed.")
        print("Run: pip install google-cloud-storage")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR connecting to GCS: {e}")
        print("Check GOOGLE_APPLICATION_CREDENTIALS in your .env file.")
        sys.exit(1)


# ── CAPTION VALIDATION ────────────────────────────────────────────────────────
REQUIRED_KEYS = {
    "caption", "angle", "environment", "lighting", "condition",
    "background_complexity", "forklift_visibility", "mast_position",
    "load_status", "quality_score", "flagged",
}

VALID_ANGLES = {
    "front", "rear", "side-left", "side-right",
    "three-quarter-front", "three-quarter-rear",
    "detail", "overhead", "unknown",
}

VALID_ENVIRONMENTS = {
    "indoor-warehouse", "outdoor-yard", "loading-dock",
    "showroom", "studio", "unknown",
}


def validate_caption(entry: dict) -> tuple[bool, list[str]]:
    """
    Validate a single caption cache entry.
    Returns (is_valid, list_of_reasons).
    """
    reasons = []

    # Required keys present
    missing = REQUIRED_KEYS - set(entry.keys())
    if missing:
        reasons.append(f"missing_keys: {missing}")
        return False, reasons

    # Caption length
    caption = entry.get("caption", "")
    if not caption or len(caption.split()) < MIN_CAPTION_LEN:
        reasons.append(f"caption_too_short: {len(caption.split())} words (min {MIN_CAPTION_LEN})")

    # Quality score
    score = entry.get("quality_score")
    if not isinstance(score, (int, float)) or score < MIN_QUALITY:
        reasons.append(f"low_quality_score: {score} (min {MIN_QUALITY})")

    # Flagged by Claude
    if entry.get("flagged") is True:
        flag_reason = entry.get("flag_reason", "no reason given")
        reasons.append(f"flagged_by_claude: {flag_reason}")

    # Validate controlled vocabulary fields
    angle = entry.get("angle", "")
    if angle and angle not in VALID_ANGLES:
        reasons.append(f"invalid_angle: '{angle}'")

    env = entry.get("environment", "")
    if env and env not in VALID_ENVIRONMENTS:
        reasons.append(f"invalid_environment: '{env}'")

    # Caption must contain at least some text referencing the forklift
    caption_lower = caption.lower()
    forklift_terms = ["forklift", "lift truck", "reach truck", "pallet", "mast",
                      "forks", "counterbalance", "order picker", "stacker", "telehandler"]
    if not any(term in caption_lower for term in forklift_terms):
        reasons.append("caption_missing_forklift_reference")

    return len(reasons) == 0, reasons


def validate_all_captions(cache: dict) -> tuple[list, list]:
    """
    Validate every entry in caption_cache.
    Returns (valid_entries, rejected_entries).
    Each entry is the original dict with custom_id added.
    """
    valid    = []
    rejected = []

    for custom_id, entry in cache.items():
        if not isinstance(entry, dict):
            rejected.append({
                "custom_id": custom_id,
                "reasons":   ["not_a_dict"],
                "entry":     str(entry)[:200],
            })
            continue

        is_valid, reasons = validate_caption(entry)
        enriched = dict(entry)
        enriched["custom_id"] = custom_id

        if is_valid:
            valid.append(enriched)
        else:
            enriched["rejection_reasons"] = reasons
            rejected.append(enriched)

    return valid, rejected


# ── CAPTION NORMALIZATION ─────────────────────────────────────────────────────
def normalize_caption_text(caption: str) -> str:
    """
    Normalize caption text:
    - Strip whitespace
    - Collapse multiple spaces
    - Ensure ends with period
    """
    import re
    caption = caption.strip()
    caption = re.sub(r"\s+", " ", caption)
    caption = re.sub(r"\n", " ", caption)
    if caption and not caption.endswith("."):
        caption += "."
    return caption


def normalize_entry(entry: dict) -> dict:
    """Normalize all string fields in a caption entry."""
    entry = dict(entry)

    if "caption" in entry:
        entry["caption"] = normalize_caption_text(entry["caption"])

    # Normalize controlled vocabulary to lowercase
    for field in ("angle", "environment", "lighting", "condition",
                  "background_complexity", "forklift_visibility",
                  "mast_position", "load_status"):
        if field in entry and isinstance(entry[field], str):
            entry[field] = entry[field].lower().strip()

    return entry


# ── IMAGE STANDARDIZATION ─────────────────────────────────────────────────────
def standardize_image(source_path: Path, target_size: int = TARGET_SIZE) -> bytes | None:
    """
    Load image, resize longest edge to target_size maintaining aspect ratio,
    pad to square with neutral gray, return as JPEG bytes.
    Returns None on failure.
    """
    try:
        from PIL import Image

        img = Image.open(source_path).convert("RGB")
        w, h = img.size

        # Resize longest edge
        ratio = target_size / max(w, h)
        new_w = int(w * ratio)
        new_h = int(h * ratio)
        img   = img.resize((new_w, new_h), Image.LANCZOS)

        # Pad to square with neutral gray
        canvas = Image.new("RGB", (target_size, target_size), (128, 128, 128))
        offset = ((target_size - new_w) // 2, (target_size - new_h) // 2)
        canvas.paste(img, offset)

        # Encode to JPEG bytes
        buffer = io.BytesIO()
        canvas.save(buffer, format="JPEG", quality=JPEG_QUALITY)
        return buffer.getvalue()

    except Exception as e:
        return None


def make_gcs_path(entry: dict) -> str:
    """
    Build the GCS object path for an image.
    Format: images/{make}/{model}/{sanitized_filename}.jpg
    """
    import re

    meta     = entry.get("metadata", {})
    make     = (meta.get("make")  or "unknown").lower().replace(" ", "_")
    model    = (meta.get("model") or "unknown").lower().replace(" ", "_")
    filename = Path(entry.get("source_file", "img.jpg")).stem

    # Sanitize all components
    make     = re.sub(r"[^a-z0-9_\-]", "_", make)[:30]
    model    = re.sub(r"[^a-z0-9_\-]", "_", model)[:30]
    filename = re.sub(r"[^a-z0-9_\-]", "_", filename.lower())[:60]

    return f"{GCS_IMAGE_PREFIX}/{make}/{model}/{filename}.jpg"


# ── TRAIN / VALIDATION SPLIT ──────────────────────────────────────────────────
def stratified_split(entries: list[dict]) -> tuple[list, list]:
    """
    Split entries into training and validation sets.
    Stratified by Make to ensure all brands appear in both sets.
    85% training, 15% validation.
    """
    random.seed(RANDOM_SEED)

    # Group by make
    by_make = defaultdict(list)
    for entry in entries:
        make = (entry.get("metadata", {}).get("make") or "unknown").lower()
        by_make[make].append(entry)

    training   = []
    validation = []

    for make, make_entries in by_make.items():
        random.shuffle(make_entries)
        split_idx = max(1, int(len(make_entries) * TRAIN_SPLIT))

        # Always put at least 1 in validation if more than 1 entry
        if len(make_entries) > 1:
            training.extend(make_entries[:split_idx])
            validation.extend(make_entries[split_idx:])
        else:
            # Only 1 entry for this make — put in training
            training.extend(make_entries)

    random.shuffle(training)
    random.shuffle(validation)

    return training, validation


# ── GCS UPLOAD & MANIFEST WRITE ───────────────────────────────────────────────
def upload_and_build_manifest(entries: list[dict], bucket,
                               split_name: str) -> tuple[list, list, list]:
    """
    For each entry: standardize the image, upload to GCS, build manifest line.
    Returns (manifest_lines, upload_log, failed).
    """
    manifest_lines = []
    upload_log     = []
    failed         = []
    total          = len(entries)

    print(f"\n  Uploading {split_name} set ({total:,} images)...")

    for i, entry in enumerate(entries):
        source_path = Path(entry.get("source_path", ""))
        gcs_path    = make_gcs_path(entry)
        gcs_uri     = f"gs://{GCS_BUCKET}/{gcs_path}"
        caption     = entry.get("caption", "")

        if (i + 1) % 100 == 0:
            print(f"    [{i+1:,}/{total:,}] Uploading...")

        # Check source exists
        if not source_path.exists():
            failed.append({
                "custom_id": entry.get("custom_id"),
                "reason":    f"source_not_found: {source_path}",
            })
            continue

        # Standardize image
        img_bytes = standardize_image(source_path)
        if img_bytes is None:
            failed.append({
                "custom_id": entry.get("custom_id"),
                "reason":    "standardize_failed",
            })
            continue

        # Upload to GCS
        try:
            blob = bucket.blob(gcs_path)

            # Skip if already uploaded (idempotent re-runs)
            if blob.exists():
                pass  # still add to manifest
            else:
                blob.upload_from_string(img_bytes, content_type="image/jpeg")

            manifest_lines.append({
                "image":   {"gcsUri": gcs_uri},
                "caption": caption,
            })

            upload_log.append({
                "custom_id":   entry.get("custom_id"),
                "source_path": str(source_path),
                "gcs_uri":     gcs_uri,
                "split":       split_name,
                "status":      "uploaded",
            })

        except Exception as e:
            failed.append({
                "custom_id": entry.get("custom_id"),
                "reason":    f"upload_error: {str(e)[:200]}",
            })

    return manifest_lines, upload_log, failed


def write_jsonl(lines: list[dict], path: Path):
    """Write a list of dicts as JSONL (one JSON object per line)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")


# ── SUMMARY ───────────────────────────────────────────────────────────────────
def print_summary(valid: list, rejected: list, training: list,
                  validation: list, all_failed: list):
    total       = len(valid) + len(rejected)
    valid_count = len(valid)
    rej_count   = len(rejected)
    train_count = len(training)
    val_count   = len(validation)
    fail_count  = len(all_failed)

    # Rejection reason breakdown
    from collections import Counter
    reasons = Counter()
    for r in rejected:
        for reason in r.get("rejection_reasons", []):
            key = reason.split(":")[0]
            reasons[key] += 1

    print("\n" + "="*60)
    print("MANIFEST BUILDER SUMMARY")
    print("="*60)
    print(f"Caption cache entries:     {total:,}")
    print(f"Passed validation:         {valid_count:,}")
    print(f"Rejected (validation):     {rej_count:,}")
    print(f"Training set:              {train_count:,}")
    print(f"Validation set:            {val_count:,}")
    print(f"Upload failures:           {fail_count:,}")
    print(f"Train/val ratio:           {train_count/(train_count+val_count)*100:.1f}% / {val_count/(train_count+val_count)*100:.1f}%")
    print()

    if reasons:
        print("Rejection reasons:")
        for reason, count in reasons.most_common():
            print(f"  {reason:<40} {count:,}")
        print()

    print(f"GCS bucket: gs://{GCS_BUCKET}/")
    print(f"Training manifest:   {TRAINING_JSONL}")
    print(f"Validation manifest: {VALIDATION_JSONL}")
    print("="*60)

    if train_count >= 2000:
        print(f"\n✅ {train_count:,} training images — strong dataset for Imagen fine-tuning.")
    elif train_count >= 500:
        print(f"\n✅ {train_count:,} training images — sufficient for fine-tuning.")
    else:
        print(f"\n⚠️  Only {train_count:,} training images. 500+ recommended.")

    if fail_count > 0:
        print(f"\n⚠️  {fail_count:,} images failed to upload.")
        print("   Check output/manifests/upload_log.json for details.")

    print(f"\n📋 Next step: Import manifests into Vertex AI")
    print(f"   Training:   gs://{GCS_BUCKET}/manifests/training.jsonl")
    print(f"   Validation: gs://{GCS_BUCKET}/manifests/validation.jsonl")


# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("CleanShot Pipeline — Step 4: Manifest Builder")
    print("="*60)

    # Load caption cache
    if not CAPTION_CACHE.exists():
        print(f"ERROR: caption_cache.json not found at {CAPTION_CACHE}")
        print("Run captioner.py first.")
        sys.exit(1)

    print(f"Loading caption cache from {CAPTION_CACHE}...")
    with open(CAPTION_CACHE, "r", encoding="utf-8") as f:
        cache = json.load(f)
    print(f"Loaded {len(cache):,} caption entries.")

    # ── Validate ──────────────────────────────────────────────────────────────
    print("\nValidating captions...")
    valid, rejected = validate_all_captions(cache)
    print(f"  Valid:    {len(valid):,}")
    print(f"  Rejected: {len(rejected):,}")

    if rejected:
        REJECTED_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(REJECTED_PATH, "w", encoding="utf-8") as f:
            json.dump(rejected, f, indent=2, ensure_ascii=False)
        print(f"  Rejected entries saved to {REJECTED_PATH}")

    if not valid:
        print("ERROR: No valid captions found. Check caption_cache.json.")
        sys.exit(1)

    # ── Normalize ─────────────────────────────────────────────────────────────
    print("\nNormalizing caption text...")
    valid = [normalize_entry(e) for e in valid]
    print(f"  Normalized {len(valid):,} entries.")

    # ── Split ─────────────────────────────────────────────────────────────────
    print("\nBuilding stratified train/validation split...")
    training_entries, validation_entries = stratified_split(valid)
    print(f"  Training:   {len(training_entries):,}")
    print(f"  Validation: {len(validation_entries):,}")

    # ── Connect to GCS ────────────────────────────────────────────────────────
    print(f"\nConnecting to GCS bucket: {GCS_BUCKET}...")
    gcs_client, bucket = get_gcs_client()
    print(f"  Connected. Project: {GCP_PROJECT}")

    # ── Upload & build manifests ───────────────────────────────────────────────
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    all_upload_log = []
    all_failed     = []

    train_lines, train_log, train_failed = upload_and_build_manifest(
        training_entries, bucket, "training"
    )
    all_upload_log.extend(train_log)
    all_failed.extend(train_failed)

    val_lines, val_log, val_failed = upload_and_build_manifest(
        validation_entries, bucket, "validation"
    )
    all_upload_log.extend(val_log)
    all_failed.extend(val_failed)

    # ── Write local JSONL manifests ────────────────────────────────────────────
    print("\nWriting JSONL manifests...")
    write_jsonl(train_lines, TRAINING_JSONL)
    write_jsonl(val_lines,   VALIDATION_JSONL)
    print(f"  training.jsonl   -> {len(train_lines):,} lines")
    print(f"  validation.jsonl -> {len(val_lines):,} lines")

    # ── Upload manifests to GCS ────────────────────────────────────────────────
    print("\nUploading manifests to GCS...")
    for local_path, gcs_name in [
        (TRAINING_JSONL,   "manifests/training.jsonl"),
        (VALIDATION_JSONL, "manifests/validation.jsonl"),
    ]:
        try:
            blob = bucket.blob(gcs_name)
            blob.upload_from_filename(str(local_path))
            print(f"  Uploaded gs://{GCS_BUCKET}/{gcs_name}")
        except Exception as e:
            print(f"  ERROR uploading {gcs_name}: {e}")

    # ── Save upload log ────────────────────────────────────────────────────────
    with open(UPLOAD_LOG, "w", encoding="utf-8") as f:
        json.dump({
            "total_uploaded": len(all_upload_log),
            "total_failed":   len(all_failed),
            "failed":         all_failed,
            "log":            all_upload_log,
        }, f, indent=2, ensure_ascii=False)

    print_summary(valid, rejected, train_lines, val_lines, all_failed)
