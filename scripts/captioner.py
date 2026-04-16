"""
captioner.py
CleanShot Pipeline — Step 3
Two-pass captioning pipeline using the Anthropic Message Batches API.

Pass 1 — claude-haiku-4-5:  Quality pre-screening of all filtered images.
          Scores each image 1-10. Images scoring below MIN_QUALITY_SCORE
          are excluded from Pass 2.

Pass 2 — claude-sonnet-4-6: Full structured caption generation on images
          that passed Pass 1 screening.

Both passes use the Batch API for 50% cost savings.
Results are cached — re-running never re-captions an already-captioned image.

Usage:
    python scripts/captioner.py               # run both passes
    python scripts/captioner.py --pass1-only  # run Pass 1 only
    python scripts/captioner.py --pass2-only  # run Pass 2 only (Pass 1 must exist)
    python scripts/captioner.py --retry       # retry errored images only

Inputs:
    output/filter_pass.json    — produced by image_filter.py

Outputs:
    output/caption_cache.json       — final merged captions from both passes
    output/pass1_cache.json         — raw Pass 1 quality scores
    output/pass2_cache.json         — raw Pass 2 full captions
    output/batch_error_log.json     — images that failed in any batch
"""

import os
import sys
import json
import time
import base64
import argparse
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ── CONFIG ────────────────────────────────────────────────────────────────────
FILTER_PASS_PATH  = Path("./output/filter_pass.json")
CAPTION_CACHE     = Path("./output/caption_cache.json")
PASS1_CACHE       = Path("./output/pass1_cache.json")
PASS2_CACHE       = Path("./output/pass2_cache.json")
ERROR_LOG         = Path("./output/batch_error_log.json")

PASS1_MODEL       = "claude-haiku-4-5"
PASS2_MODEL       = "claude-sonnet-4-6"
MIN_QUALITY_SCORE = 4       # Pass 1 score threshold — below this = excluded
MAX_IMAGE_LONG_EDGE = 1024  # resize before encoding to keep token count low
BATCH_SIZE        = 2000    # images per batch submission
POLL_INTERVAL     = 120     # seconds between batch status checks

# ── PROMPTS ───────────────────────────────────────────────────────────────────
PASS1_SYSTEM = """You are a quality control analyst for a forklift image dataset.
Your job is to quickly assess whether an image is suitable for AI model training.
Always respond with a single JSON object and nothing else — no markdown, no preamble."""

PASS1_USER_TEMPLATE = """Assess this forklift image for training suitability.
Known metadata: Make: {make}, Model: {model}, Year: {year}

Respond ONLY with this JSON object:
{{
  "quality_score": <integer 1-10>,
  "flagged": <true or false>,
  "flag_reason": "<reason or null>",
  "brief_note": "<one sentence description of what you see>"
}}

Scoring guide:
10 = Perfect: clear, well-lit, full forklift visible, clean background
7-9 = Good: minor issues but clearly usable
4-6 = Marginal: blurry, partial, heavily obstructed, or poor lighting
1-3 = Reject: wrong subject, too degraded, or completely unusable"""

PASS2_SYSTEM = """You are a professional forklift image analyst generating training captions
for an AI image generation model. Your captions must be factual, specific, and consistent.
Always respond with a single JSON object and nothing else — no markdown, no preamble."""

PASS2_USER_TEMPLATE = """Analyze this forklift image and generate a detailed training caption.
Known metadata from folder name:
- Make: {make}
- Model: {model}
- Year: {year}
- Fuel Type: {fuel_type}
- Tire Type: {tire_type}
- Capacity: {capacity}
- Cab: {cab}

Return ONLY a JSON object with these exact keys:
{{
  "caption": "<full natural language caption for Imagen training>",
  "angle": "<front|rear|side-left|side-right|three-quarter-front|three-quarter-rear|detail|overhead|unknown>",
  "environment": "<indoor-warehouse|outdoor-yard|loading-dock|showroom|studio|unknown>",
  "lighting": "<well-lit|dim|harsh-shadows|mixed>",
  "condition": "<new|clean-used|worn|damaged|heavily-worn>",
  "background_complexity": "<plain|moderate|cluttered|studio-white>",
  "forklift_visibility": "<full|partial-front|partial-rear|mast-detail|operator-area>",
  "mast_position": "<lowered|raised|tilted|unknown>",
  "load_status": "<unloaded|loaded-pallet|forks-occupied|unknown>",
  "quality_score": <integer 1-10>,
  "flagged": <true or false>,
  "flag_reason": "<reason or null>"
}}

Caption requirements:
- Start with the year, make, and model
- Include fuel type, tire type, and capacity
- Describe the angle, environment, and lighting
- Describe the forklift condition
- Be specific — avoid vague language
- End with a period
- Minimum 40 words"""


# ── ANTHROPIC CLIENT ──────────────────────────────────────────────────────────
def get_client():
    try:
        import anthropic
        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            print("ERROR: ANTHROPIC_API_KEY not found in .env file.")
            sys.exit(1)
        return anthropic.Anthropic(api_key=key)
    except ImportError:
        print("ERROR: anthropic not installed. Run: pip install anthropic")
        sys.exit(1)


# ── IMAGE ENCODING ────────────────────────────────────────────────────────────
def encode_image(image_path: Path, max_long_edge: int = MAX_IMAGE_LONG_EDGE) -> tuple[str | None, str | None]:
    """
    Load, optionally resize, and base64-encode an image for the API.
    Returns (base64_string, media_type) or (None, None) on failure.
    Resizes the longest edge to max_long_edge to keep token counts low.
    """
    try:
        from PIL import Image
        import io

        img = Image.open(image_path).convert("RGB")
        w, h = img.size

        # Resize if needed — maintain aspect ratio
        if max(w, h) > max_long_edge:
            ratio  = max_long_edge / max(w, h)
            new_w  = int(w * ratio)
            new_h  = int(h * ratio)
            img    = img.resize((new_w, new_h), Image.LANCZOS)

        # Encode to JPEG bytes
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=90)
        buffer.seek(0)

        b64 = base64.standard_b64encode(buffer.read()).decode("utf-8")
        return b64, "image/jpeg"

    except Exception as e:
        return None, str(e)


# ── BATCH BUILDING ────────────────────────────────────────────────────────────
def make_custom_id(record: dict) -> str:
    """
    Build a unique, reversible custom_id for a batch request.
    Format: {make}__{model}__{filename_stem}
    Sanitized to only contain alphanumeric, underscore, hyphen.
    Max 64 chars.
    """
    import re
    make     = (record.get("metadata", {}).get("make")  or "unknown").lower()
    model    = (record.get("metadata", {}).get("model") or "unknown").lower()
    filename = Path(record["path"]).stem

    raw = f"{make}__{model}__{filename}"
    sanitized = re.sub(r"[^a-z0-9_\-]", "_", raw)
    return sanitized[:64]


def build_pass1_request(record: dict, b64: str, media_type: str) -> dict:
    """Build a single Pass 1 batch request item."""
    meta = record.get("metadata", {})
    prompt = PASS1_USER_TEMPLATE.format(
        make  = meta.get("make")  or "Unknown",
        model = meta.get("model") or "Unknown",
        year  = meta.get("year")  or "Unknown",
    )
    return {
        "custom_id": make_custom_id(record),
        "params": {
            "model":      PASS1_MODEL,
            "max_tokens": 200,
            "system":     PASS1_SYSTEM,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {
                    "type":       "base64",
                    "media_type": media_type,
                    "data":       b64,
                }},
                {"type": "text", "text": prompt},
            ]}],
        }
    }


def build_pass2_request(record: dict, b64: str, media_type: str) -> dict:
    """Build a single Pass 2 batch request item."""
    meta = record.get("metadata", {})
    prompt = PASS2_USER_TEMPLATE.format(
        make       = meta.get("make")       or "Unknown",
        model      = meta.get("model")      or "Unknown",
        year       = meta.get("year")       or "Unknown",
        fuel_type  = meta.get("fuel_type")  or "Unknown",
        tire_type  = meta.get("tire_type")  or "Unknown",
        capacity   = meta.get("capacity")   or "Unknown",
        cab        = "Yes" if meta.get("cab") else "No",
    )
    return {
        "custom_id": make_custom_id(record),
        "params": {
            "model":      PASS2_MODEL,
            "max_tokens": 700,
            "system":     PASS2_SYSTEM,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {
                    "type":       "base64",
                    "media_type": media_type,
                    "data":       b64,
                }},
                {"type": "text", "text": prompt},
            ]}],
        }
    }


# ── BATCH SUBMISSION ──────────────────────────────────────────────────────────
def submit_batches(client, records: list[dict], pass_num: int,
                   build_fn, existing_cache: dict) -> list[str]:
    """
    Encode images and submit in batches of BATCH_SIZE.
    Skips any record whose custom_id is already in existing_cache.
    Returns list of batch IDs submitted.
    """
    batch_ids    = []
    current_batch = []
    skipped      = 0
    encode_errors = 0
    total        = len(records)

    print(f"\nPass {pass_num}: Building batch requests for {total:,} images...")

    for i, record in enumerate(records):
        custom_id = make_custom_id(record)

        # Skip if already cached
        if custom_id in existing_cache:
            skipped += 1
            continue

        img_path = Path(record["path"])
        if not img_path.exists():
            encode_errors += 1
            continue

        b64, media_type = encode_image(img_path)
        if b64 is None:
            encode_errors += 1
            continue

        if pass_num == 1:
            req = build_pass1_request(record, b64, media_type)
        else:
            req = build_pass2_request(record, b64, media_type)

        current_batch.append((custom_id, req, record))

        # Submit when batch is full
        if len(current_batch) >= BATCH_SIZE:
            batch_id = _submit_single_batch(client, current_batch, pass_num, len(batch_ids) + 1)
            if batch_id:
                batch_ids.append(batch_id)
            current_batch = []

        if (i + 1) % 200 == 0:
            print(f"  Encoded {i+1:,}/{total:,}  "
                  f"({skipped:,} skipped from cache, {encode_errors:,} encode errors)")

    # Submit any remaining
    if current_batch:
        batch_id = _submit_single_batch(client, current_batch, pass_num, len(batch_ids) + 1)
        if batch_id:
            batch_ids.append(batch_id)

    print(f"\nPass {pass_num} submission complete:")
    print(f"  Batches submitted:  {len(batch_ids)}")
    print(f"  Skipped (cached):   {skipped:,}")
    print(f"  Encode errors:      {encode_errors:,}")

    return batch_ids


def _submit_single_batch(client, batch_items: list, pass_num: int, batch_num: int) -> str | None:
    """Submit a single batch to the API. Returns batch ID or None on failure."""
    requests = [item[1] for item in batch_items]
    try:
        batch = client.messages.batches.create(requests=requests)
        print(f"  Batch {batch_num} submitted: {batch.id}  "
              f"({len(requests):,} requests)")
        return batch.id
    except Exception as e:
        print(f"  ERROR submitting batch {batch_num}: {e}")
        return None


# ── BATCH POLLING ─────────────────────────────────────────────────────────────
def wait_for_batches(client, batch_ids: list[str]) -> list[str]:
    """
    Poll until all batches are complete.
    Returns list of completed batch IDs.
    """
    if not batch_ids:
        return []

    pending   = list(batch_ids)
    completed = []

    print(f"\nPolling {len(pending)} batch(es) every {POLL_INTERVAL}s...")
    print("(This may take 1-4 hours for large runs. Safe to leave running.)\n")

    while pending:
        still_pending = []

        for batch_id in pending:
            try:
                batch  = client.messages.batches.retrieve(batch_id)
                counts = batch.request_counts
                status = batch.processing_status

                print(f"  {batch_id[:24]}...  "
                      f"processing={counts.processing}  "
                      f"succeeded={counts.succeeded}  "
                      f"errored={counts.errored}  "
                      f"status={status}")

                if status == "ended":
                    completed.append(batch_id)
                else:
                    still_pending.append(batch_id)

            except Exception as e:
                print(f"  ERROR polling {batch_id}: {e}")
                still_pending.append(batch_id)

        pending = still_pending

        if pending:
            print(f"\n  {len(pending)} batch(es) still processing. "
                  f"Next check in {POLL_INTERVAL}s...\n")
            time.sleep(POLL_INTERVAL)

    print(f"\nAll {len(completed)} batch(es) complete.")
    return completed


# ── RESULT RETRIEVAL ──────────────────────────────────────────────────────────
def retrieve_results(client, batch_ids: list[str],
                     existing_cache: dict, error_log: list) -> dict:
    """
    Retrieve results from all completed batches.
    Merges into existing_cache and returns updated cache.
    """
    cache = dict(existing_cache)

    for batch_id in batch_ids:
        print(f"\nRetrieving results from {batch_id}...")
        succeeded = 0
        errored   = 0
        parse_err = 0

        try:
            for result in client.messages.batches.results(batch_id):
                custom_id = result.custom_id

                if result.result.type == "succeeded":
                    raw_text = result.result.message.content[0].text
                    try:
                        # Strip any accidental markdown fences
                        clean = raw_text.strip()
                        if clean.startswith("```"):
                            clean = clean.split("\n", 1)[1]
                            clean = clean.rsplit("```", 1)[0]
                        parsed = json.loads(clean)
                        cache[custom_id] = parsed
                        succeeded += 1
                    except json.JSONDecodeError:
                        error_log.append({
                            "batch_id":  batch_id,
                            "custom_id": custom_id,
                            "error":     "json_parse_failed",
                            "raw":       raw_text[:500],
                        })
                        parse_err += 1

                elif result.result.type == "errored":
                    error_log.append({
                        "batch_id":  batch_id,
                        "custom_id": custom_id,
                        "error":     result.result.error.type,
                    })
                    errored += 1

        except Exception as e:
            print(f"  ERROR retrieving batch {batch_id}: {e}")

        print(f"  Succeeded: {succeeded:,}  "
              f"Errored: {errored:,}  "
              f"Parse errors: {parse_err:,}")

    return cache


# ── CACHE I/O ─────────────────────────────────────────────────────────────────
def load_cache(path: Path) -> dict:
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def save_error_log(errors: list):
    ERROR_LOG.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if ERROR_LOG.exists():
        with open(ERROR_LOG, "r", encoding="utf-8") as f:
            existing = json.load(f)
    existing.extend(errors)
    with open(ERROR_LOG, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2, ensure_ascii=False)


# ── PASS 1 ────────────────────────────────────────────────────────────────────
def run_pass1(client, records: list[dict]) -> dict:
    """
    Pass 1: Quality pre-screening with Haiku.
    Returns pass1_cache dict mapping custom_id -> quality result.
    """
    print("\n" + "="*60)
    print(f"PASS 1 — Quality Screening  ({PASS1_MODEL})")
    print("="*60)

    pass1_cache = load_cache(PASS1_CACHE)
    error_log   = []

    already_done = sum(1 for r in records if make_custom_id(r) in pass1_cache)
    print(f"Records to process: {len(records):,}")
    print(f"Already cached:     {already_done:,}")
    print(f"To submit:          {len(records) - already_done:,}")

    if len(records) - already_done == 0:
        print("All Pass 1 results already cached — skipping submission.")
        return pass1_cache

    batch_ids = submit_batches(client, records, 1, build_pass1_request, pass1_cache)

    if batch_ids:
        completed = wait_for_batches(client, batch_ids)
        pass1_cache = retrieve_results(client, completed, pass1_cache, error_log)
        save_cache(pass1_cache, PASS1_CACHE)
        if error_log:
            save_error_log(error_log)

    # Summary
    scores = [v.get("quality_score", 0) for v in pass1_cache.values()
              if isinstance(v, dict)]
    if scores:
        passing = sum(1 for s in scores if s >= MIN_QUALITY_SCORE)
        avg     = sum(scores) / len(scores)
        print(f"\nPass 1 results:")
        print(f"  Total scored:           {len(scores):,}")
        print(f"  Passing (score >={MIN_QUALITY_SCORE}):    {passing:,}")
        print(f"  Excluded (score <{MIN_QUALITY_SCORE}):     {len(scores) - passing:,}")
        print(f"  Average quality score:  {avg:.1f}")

    return pass1_cache


# ── PASS 2 ────────────────────────────────────────────────────────────────────
def run_pass2(client, records: list[dict], pass1_cache: dict) -> dict:
    """
    Pass 2: Full caption generation with Sonnet on images that passed Pass 1.
    Returns pass2_cache dict mapping custom_id -> full caption result.
    """
    print("\n" + "="*60)
    print(f"PASS 2 — Caption Generation  ({PASS2_MODEL})")
    print("="*60)

    # Filter to only images that passed Pass 1
    pass1_passing = []
    pass1_failing = []
    unscored      = []

    for record in records:
        cid    = make_custom_id(record)
        result = pass1_cache.get(cid)
        if result is None:
            unscored.append(record)
            continue
        score = result.get("quality_score", 0) if isinstance(result, dict) else 0
        if score >= MIN_QUALITY_SCORE:
            pass1_passing.append(record)
        else:
            pass1_failing.append(record)

    print(f"Pass 1 results:")
    print(f"  Passed (score >={MIN_QUALITY_SCORE}): {len(pass1_passing):,}")
    print(f"  Failed (score <{MIN_QUALITY_SCORE}):  {len(pass1_failing):,}")
    print(f"  Unscored:        {len(unscored):,}  (will be included)")

    # Include unscored images — they didn't get a score so give benefit of doubt
    to_caption = pass1_passing + unscored
    print(f"  Total for Pass 2:{len(to_caption):,}")

    pass2_cache = load_cache(PASS2_CACHE)
    error_log   = []

    already_done = sum(1 for r in to_caption if make_custom_id(r) in pass2_cache)
    print(f"\nAlready cached: {already_done:,}")
    print(f"To submit:      {len(to_caption) - already_done:,}")

    if len(to_caption) - already_done == 0:
        print("All Pass 2 results already cached — skipping submission.")
        return pass2_cache

    batch_ids = submit_batches(client, to_caption, 2, build_pass2_request, pass2_cache)

    if batch_ids:
        completed   = wait_for_batches(client, batch_ids)
        pass2_cache = retrieve_results(client, completed, pass2_cache, error_log)
        save_cache(pass2_cache, PASS2_CACHE)
        if error_log:
            save_error_log(error_log)

    print(f"\nPass 2 complete: {len(pass2_cache):,} captions in cache.")
    return pass2_cache


# ── MERGE CACHES ──────────────────────────────────────────────────────────────
def build_final_cache(records: list[dict], pass1_cache: dict,
                      pass2_cache: dict) -> dict:
    """
    Merge Pass 1 and Pass 2 results into the final caption_cache.
    Each entry includes the full Pass 2 caption plus Pass 1 quality score,
    source path, and folder metadata.
    """
    final = {}

    for record in records:
        cid     = make_custom_id(record)
        pass2   = pass2_cache.get(cid)
        pass1   = pass1_cache.get(cid, {})

        if not pass2 or not isinstance(pass2, dict):
            continue

        # Attach source info and metadata to each caption entry
        entry = dict(pass2)
        entry["custom_id"]       = cid
        entry["source_file"]     = record.get("filename")
        entry["source_folder"]   = record.get("folder")
        entry["source_path"]     = record.get("path")
        entry["metadata"]        = record.get("metadata", {})
        entry["pass1_score"]     = pass1.get("quality_score") if isinstance(pass1, dict) else None
        entry["pass1_note"]      = pass1.get("brief_note")    if isinstance(pass1, dict) else None
        entry["filter_flags"]    = record.get("flags", [])
        entry["blur_score"]      = record.get("blur_score")

        final[cid] = entry

    return final


# ── PRINT FINAL SUMMARY ───────────────────────────────────────────────────────
def print_final_summary(records: list[dict], pass1_cache: dict,
                        pass2_cache: dict, final_cache: dict):
    total_filtered = len(records)
    pass1_scored   = len(pass1_cache)
    pass2_total    = len(pass2_cache)
    final_total    = len(final_cache)

    # Quality score distribution
    from collections import Counter
    score_dist = Counter()
    for v in pass2_cache.values():
        if isinstance(v, dict):
            score = v.get("quality_score")
            if score:
                score_dist[score] += 1

    # Angle distribution
    angle_dist = Counter()
    for v in final_cache.values():
        angle = v.get("angle", "unknown")
        angle_dist[angle] += 1

    # Env distribution
    env_dist = Counter()
    for v in final_cache.values():
        env = v.get("environment", "unknown")
        env_dist[env] += 1

    print("\n" + "="*60)
    print("CAPTIONING COMPLETE — FINAL SUMMARY")
    print("="*60)
    print(f"Images filtered (input):  {total_filtered:,}")
    print(f"Pass 1 scored:            {pass1_scored:,}")
    print(f"Pass 2 captioned:         {pass2_total:,}")
    print(f"Final caption cache:      {final_total:,}")
    print()

    if score_dist:
        print("Quality Score Distribution (Pass 2):")
        for score in sorted(score_dist.keys(), reverse=True):
            bar = "█" * (score_dist[score] // max(1, max(score_dist.values()) // 20))
            print(f"  {score:2d}  {score_dist[score]:>5,}  {bar}")
        print()

    if angle_dist:
        print("Angle Distribution:")
        for angle, count in angle_dist.most_common():
            print(f"  {angle:<35} {count:,}")
        print()

    if env_dist:
        print("Environment Distribution:")
        for env, count in env_dist.most_common():
            print(f"  {env:<35} {count:,}")

    print("="*60)

    # Error log summary
    if ERROR_LOG.exists():
        with open(ERROR_LOG, "r") as f:
            errors = json.load(f)
        if errors:
            print(f"\n⚠️  {len(errors):,} errors logged in output/batch_error_log.json")
            print("   Re-run with --retry to attempt these images again.")

    if final_total >= 2000:
        print(f"\n✅ {final_total:,} captions ready — strong dataset for Imagen fine-tuning.")
    elif final_total >= 500:
        print(f"\n✅ {final_total:,} captions ready — sufficient for basic fine-tuning.")
    else:
        print(f"\n⚠️  Only {final_total:,} captions. Minimum 500 recommended.")


# ── RETRY MODE ────────────────────────────────────────────────────────────────
def run_retry(client, records: list[dict]):
    """
    Re-submit only images that appear in the error log.
    Runs them through Pass 2 only (assumes Pass 1 already complete).
    """
    print("\n" + "="*60)
    print("RETRY MODE — Re-submitting errored images")
    print("="*60)

    if not ERROR_LOG.exists():
        print("No error log found. Nothing to retry.")
        return

    with open(ERROR_LOG, "r") as f:
        errors = json.load(f)

    error_ids = {e["custom_id"] for e in errors}
    to_retry  = [r for r in records if make_custom_id(r) in error_ids]

    print(f"Errored images in log: {len(error_ids):,}")
    print(f"Found in filter pass:  {len(to_retry):,}")

    if not to_retry:
        print("No matching images found to retry.")
        return

    pass2_cache = load_cache(PASS2_CACHE)
    error_log   = []

    batch_ids = submit_batches(client, to_retry, 2, build_pass2_request, pass2_cache)
    if batch_ids:
        completed   = wait_for_batches(client, batch_ids)
        pass2_cache = retrieve_results(client, completed, pass2_cache, error_log)
        save_cache(pass2_cache, PASS2_CACHE)
        if error_log:
            save_error_log(error_log)
        print(f"Retry complete. Pass 2 cache now has {len(pass2_cache):,} entries.")


# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CleanShot captioning pipeline")
    parser.add_argument("--pass1-only", action="store_true", help="Run Pass 1 only")
    parser.add_argument("--pass2-only", action="store_true", help="Run Pass 2 only")
    parser.add_argument("--retry",      action="store_true", help="Retry errored images")
    args = parser.parse_args()

    print("CleanShot Pipeline — Step 3: Captioning")
    print("="*60)

    # Load filtered image list
    if not FILTER_PASS_PATH.exists():
        print(f"ERROR: filter_pass.json not found at {FILTER_PASS_PATH}")
        print("Run image_filter.py first.")
        sys.exit(1)

    print(f"Loading filtered image list from {FILTER_PASS_PATH}...")
    with open(FILTER_PASS_PATH, "r", encoding="utf-8") as f:
        records = json.load(f)

    print(f"Loaded {len(records):,} images for captioning.")
    print(f"Batch size:        {BATCH_SIZE:,} images per batch")
    print(f"Pass 1 model:      {PASS1_MODEL}")
    print(f"Pass 2 model:      {PASS2_MODEL}")
    print(f"Min quality score: {MIN_QUALITY_SCORE}")
    print(f"Poll interval:     {POLL_INTERVAL}s")

    client = get_client()

    if args.retry:
        run_retry(client, records)
        sys.exit(0)

    # ── Pass 1 ────────────────────────────────────────────────────────────────
    pass1_cache = {}
    if not args.pass2_only:
        pass1_cache = run_pass1(client, records)
        save_cache(pass1_cache, PASS1_CACHE)
    else:
        pass1_cache = load_cache(PASS1_CACHE)
        print(f"\nPass 2 only mode — loaded {len(pass1_cache):,} Pass 1 results from cache.")

    # ── Pass 2 ────────────────────────────────────────────────────────────────
    pass2_cache = {}
    if not args.pass1_only:
        pass2_cache = run_pass2(client, records, pass1_cache)
        save_cache(pass2_cache, PASS2_CACHE)
    else:
        print(f"\nPass 1 only mode — stopping here.")
        sys.exit(0)

    # ── Merge and save final cache ────────────────────────────────────────────
    print("\nBuilding final caption cache...")
    final_cache = build_final_cache(records, pass1_cache, pass2_cache)
    save_cache(final_cache, CAPTION_CACHE)
    print(f"caption_cache.json written: {len(final_cache):,} entries")

    print_final_summary(records, pass1_cache, pass2_cache, final_cache)
