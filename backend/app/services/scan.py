"""
Scan Service — Multi-provider artifact detection for AI-generated forklift photos.

Calls Gemini 2.5 Flash, OpenAI gpt-4o, and Anthropic claude-sonnet-4-5 IN PARALLEL
via asyncio.gather and merges the verdicts via majority vote.

Voting (per Phase 4.5 v2.0 §2.3):
  - Full agreement (all N agree)        → confidence × 1.0,  agreement="full"
  - Majority    (strict majority)       → confidence × 0.85, agreement="majority"
  - Split       (no majority)           → REVIEW (unless ALL FAIL), × 0.65, agreement="split"

Per-check status: take the WORST status across reporting providers.
Notes from non-skip providers are concatenated with provider attribution.

Failure tolerance (per §2.5):
  - 1-2 provider failures: graceful degradation; `source` indicates contributors
                           and `warnings` lists the failures.
  - All providers failed:  RuntimeError raised; worker marks job failed.

Auth:
  - Gemini       : Vertex AI ADC. Reuses the singleton from app.services.gemini.
  - OpenAI       : OPENAI_API_KEY     (env var, mounted from Secret Manager on worker pool)
  - Anthropic    : ANTHROPIC_API_KEY  (env var, mounted from Secret Manager on worker pool)

Output schema (per Phase 2 v2.4 §2.4) — see _final_envelope() at the bottom.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from typing import Any, Optional

import structlog

from app.services import gemini as gemini_service


logger = structlog.get_logger()


# -----------------------------------------------------------------------------
# Model IDs and tuning constants
# -----------------------------------------------------------------------------

# Gemini scan uses the text/JSON model, NOT settings.gemini_model
# (which is gemini-2.5-flash-image, the image generation model used for Enhance).
GEMINI_SCAN_MODEL = "gemini-2.5-flash"
OPENAI_SCAN_MODEL = "gpt-4o"
ANTHROPIC_SCAN_MODEL = "claude-sonnet-4-5"

# Per-provider call timeout (seconds). The worker job_timeout is 480s, so we
# have plenty of headroom; this just prevents one stuck provider from making
# the whole scan wait for the asyncio.gather floor.
PROVIDER_TIMEOUT_S = 45.0

# Anthropic doesn't have a hard JSON mode; cap output tokens generously.
ANTHROPIC_MAX_TOKENS = 2048

# Verdict / status vocabulary
VERDICTS = ("PASS", "REVIEW", "FAIL")
STATUSES = ("ok", "warn", "bad", "skip")
STATUS_RANK = {"skip": 0, "ok": 1, "warn": 2, "bad": 3}

# Confidence multipliers by agreement
MULTIPLIER_FULL = 1.0
MULTIPLIER_MAJORITY = 0.85
MULTIPLIER_SPLIT = 0.65

# 12 check categories (per Phase 2 v2.4 §2.4)
CHECK_CATEGORIES = (
    "limb_count",
    "finger_detail",
    "face_anatomy",
    "forklift_forks",
    "forklift_mast",
    "operator_seat",
    "wheel_count",
    "duplicate_objects",
    "text_legibility",
    "lighting_shadows",
    "background_coherence",
    "proportions",
)


# -----------------------------------------------------------------------------
# Lazy client init (constructors are expensive; create once per worker process)
# -----------------------------------------------------------------------------

_openai_client: Any = None
_anthropic_client: Any = None


def _get_openai_client() -> Any:
    """Lazy-init OpenAI async client. Returns None if no API key is present."""
    global _openai_client
    if _openai_client is not None:
        return _openai_client
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    from openai import AsyncOpenAI  # local import: keeps API service slim
    _openai_client = AsyncOpenAI(api_key=api_key, timeout=PROVIDER_TIMEOUT_S)
    logger.info("OpenAI client initialized", model=OPENAI_SCAN_MODEL)
    return _openai_client


def _get_anthropic_client() -> Any:
    """Lazy-init Anthropic async client. Returns None if no API key is present."""
    global _anthropic_client
    if _anthropic_client is not None:
        return _anthropic_client
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    from anthropic import AsyncAnthropic  # local import: keeps API service slim
    _anthropic_client = AsyncAnthropic(api_key=api_key, timeout=PROVIDER_TIMEOUT_S)
    logger.info("Anthropic client initialized", model=ANTHROPIC_SCAN_MODEL)
    return _anthropic_client


# -----------------------------------------------------------------------------
# Shared scan prompt (provider-agnostic)
# -----------------------------------------------------------------------------

SYSTEM_INSTRUCTIONS = (
    "You are a quality reviewer for AI-generated photographs of forklifts and "
    "warehouse equipment. Inspect the image for visual artifacts, anatomical "
    "errors, equipment-specific implausibilities, and compositional problems "
    "that would prevent the image from being published on a dealership listing. "
    "Be terse and concrete. Do not speculate beyond what is visible."
)

CHECK_DESCRIPTIONS = {
    "limb_count":           "If a person is visible: do they have the correct number of arms and legs?",
    "finger_detail":        "If hands are visible: are fingers anatomically plausible (count, articulation, no fusion)?",
    "face_anatomy":         "If a face is visible: are eyes/nose/mouth/ears placed and shaped naturally?",
    "forklift_forks":       "Are the lifting forks correctly shaped, mounted, and free of geometric distortion?",
    "forklift_mast":        "Is the mast assembly geometrically correct (rails parallel, hoses plausible, carriage aligned)?",
    "operator_seat":        "Is the operator compartment plausible (seat, controls, overhead guard structure)?",
    "wheel_count":          "Correct number of wheels for this forklift type, and do they look real?",
    "duplicate_objects":    "Any duplicated, fused, or impossibly-overlapping objects?",
    "text_legibility":      "Visible text/decals/serial plates: are letters real letters, not LLM gibberish?",
    "lighting_shadows":     "Lighting consistent (one light source, shadows correct direction, reflections matching)?",
    "background_coherence": "Background consistent and free of warps/distortions/impossible geometry?",
    "proportions":          "Forklift overall proportions correct relative to itself and any reference objects?",
}

_CHECK_DESC_BLOCK = "\n".join(f"  - {k}: {v}" for k, v in CHECK_DESCRIPTIONS.items())

USER_PROMPT = f"""Inspect the attached forklift photograph for AI-generation artifacts.

For each of these 12 categories, assign a status:
  - "ok"   = no issue
  - "warn" = minor issue, image still publishable
  - "bad"  = real problem, blocks publication
  - "skip" = not applicable to this image (e.g., no human visible -> limb_count=skip)

Categories:
{_CHECK_DESC_BLOCK}

Then assign an overall verdict:
  - "PASS"   = no "bad" statuses, at most 1-2 "warn"
  - "REVIEW" = some "warn" but no "bad", or one borderline "bad"
  - "FAIL"   = clear "bad" status that blocks publication

Return ONLY a single JSON object matching exactly this shape (no prose, no markdown fences):

{{
  "verdict": "PASS" | "REVIEW" | "FAIL",
  "confidence": <integer 0-100>,
  "summary": "<one short sentence>",
  "issues": ["<short issue string>", ...],
  "checks": {{
    "limb_count":           {{"status": "...", "note": "..."}},
    "finger_detail":        {{"status": "...", "note": "..."}},
    "face_anatomy":         {{"status": "...", "note": "..."}},
    "forklift_forks":       {{"status": "...", "note": "..."}},
    "forklift_mast":        {{"status": "...", "note": "..."}},
    "operator_seat":        {{"status": "...", "note": "..."}},
    "wheel_count":          {{"status": "...", "note": "..."}},
    "duplicate_objects":    {{"status": "...", "note": "..."}},
    "text_legibility":      {{"status": "...", "note": "..."}},
    "lighting_shadows":     {{"status": "...", "note": "..."}},
    "background_coherence": {{"status": "...", "note": "..."}},
    "proportions":          {{"status": "...", "note": "..."}}
  }}
}}
"""


# -----------------------------------------------------------------------------
# Per-provider call wrappers
# -----------------------------------------------------------------------------

async def _scan_with_gemini(*, image_gcs_uri: str, mime_type: str) -> dict:
    """Call Gemini 2.5 Flash (text/JSON) with the gs:// URI directly."""
    from google.genai import types as genai_types

    client = gemini_service.get_client()

    parts = [
        genai_types.Part.from_uri(file_uri=image_gcs_uri, mime_type=mime_type),
        genai_types.Part.from_text(text=USER_PROMPT),
    ]

    response = await client.aio.models.generate_content(
        model=GEMINI_SCAN_MODEL,
        contents=parts,
        config=genai_types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTIONS,
            response_mime_type="application/json",
            temperature=0.2,
        ),
    )

    text = _extract_text_from_genai_response(response)
    if not text:
        raise RuntimeError("Gemini returned no text content")
    return _parse_provider_json(text, provider="gemini")


def _extract_text_from_genai_response(response: Any) -> Optional[str]:
    """Walk a generate_content response and return the first text part."""
    if not getattr(response, "candidates", None):
        return None
    for cand in response.candidates:
        content = getattr(cand, "content", None)
        if not content or not getattr(content, "parts", None):
            continue
        for part in content.parts:
            text = getattr(part, "text", None)
            if text:
                return text
    return None


async def _scan_with_openai(*, image_b64: str, mime_type: str) -> dict:
    """Call gpt-4o vision with base64 image and JSON response mode."""
    client = _get_openai_client()
    if client is None:
        raise RuntimeError("OPENAI_API_KEY not configured")

    response = await client.chat.completions.create(
        model=OPENAI_SCAN_MODEL,
        response_format={"type": "json_object"},
        temperature=0.2,
        messages=[
            {"role": "system", "content": SYSTEM_INSTRUCTIONS},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{image_b64}",
                        },
                    },
                ],
            },
        ],
    )

    if not response.choices:
        raise RuntimeError("OpenAI returned no choices")
    text = response.choices[0].message.content
    if not text:
        raise RuntimeError("OpenAI returned empty content")
    return _parse_provider_json(text, provider="openai")


async def _scan_with_anthropic(*, image_b64: str, mime_type: str) -> dict:
    """Call claude-sonnet-4-5 with base64 image. JSON enforced via prompt + parsing."""
    client = _get_anthropic_client()
    if client is None:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")

    response = await client.messages.create(
        model=ANTHROPIC_SCAN_MODEL,
        max_tokens=ANTHROPIC_MAX_TOKENS,
        temperature=0.2,
        system=SYSTEM_INSTRUCTIONS,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": USER_PROMPT},
                ],
            }
        ],
    )

    text_blocks = [
        block.text for block in response.content
        if getattr(block, "type", None) == "text"
    ]
    if not text_blocks:
        raise RuntimeError("Anthropic returned no text blocks")
    return _parse_provider_json("\n".join(text_blocks), provider="anthropic")


# -----------------------------------------------------------------------------
# JSON parsing — defensive (LLMs occasionally leak markdown fences)
# -----------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE | re.MULTILINE)


def _parse_provider_json(text: str, *, provider: str) -> dict:
    """Strip markdown fences, JSON-decode, then normalize shape."""
    cleaned = _FENCE_RE.sub("", text).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        # Last-ditch: extract the first balanced-looking {...} block
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            raise RuntimeError(
                f"{provider}: response was not JSON: {cleaned[:200]!r}"
            ) from exc
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as exc2:
            raise RuntimeError(
                f"{provider}: could not parse JSON even after fence strip: {cleaned[:200]!r}"
            ) from exc2

    if not isinstance(data, dict):
        raise RuntimeError(f"{provider}: top-level JSON value is not an object")

    return _normalize_provider_result(data, provider=provider)


def _normalize_provider_result(data: dict, *, provider: str) -> dict:
    """Coerce provider output into the canonical per-provider shape."""
    verdict = str(data.get("verdict", "REVIEW")).upper()
    if verdict not in VERDICTS:
        verdict = "REVIEW"

    raw_conf = data.get("confidence", 50)
    try:
        confidence = max(0, min(100, int(raw_conf)))
    except (TypeError, ValueError):
        confidence = 50

    summary = str(data.get("summary", "")).strip()[:300]

    raw_issues = data.get("issues", [])
    if isinstance(raw_issues, list):
        issues = [str(i).strip() for i in raw_issues if str(i).strip()][:20]
    else:
        issues = []

    raw_checks = data.get("checks") or {}
    checks: dict[str, dict] = {}
    for cat in CHECK_CATEGORIES:
        c = raw_checks.get(cat) if isinstance(raw_checks, dict) else None
        c = c if isinstance(c, dict) else {}
        status = str(c.get("status", "skip")).lower()
        if status not in STATUSES:
            status = "skip"
        note = str(c.get("note", "")).strip()[:300]
        checks[cat] = {"status": status, "note": note}

    return {
        "provider": provider,
        "verdict": verdict,
        "confidence": confidence,
        "summary": summary,
        "issues": issues,
        "checks": checks,
    }


# -----------------------------------------------------------------------------
# Voting / merge
# -----------------------------------------------------------------------------

def _merge_results(results: list[dict]) -> tuple[str, int, str, str, list[str], dict]:
    """
    Merge N successful provider results.

    Caller guarantees len(results) >= 1.

    Returns: (verdict, confidence, agreement, summary, issues, checks)
    """
    n = len(results)
    verdicts = [r["verdict"] for r in results]

    counts: dict[str, int] = {}
    for v in verdicts:
        counts[v] = counts.get(v, 0) + 1

    top_verdict, top_count = max(counts.items(), key=lambda kv: kv[1])

    if n == 1:
        # Single provider survived — no voting possible. Treat as full agreement
        # of N=1 with no multiplier penalty. Source field downstream will record
        # which provider it was.
        agreement = "full"
        multiplier = MULTIPLIER_FULL
        final_verdict = top_verdict
    elif top_count == n:
        agreement = "full"
        multiplier = MULTIPLIER_FULL
        final_verdict = top_verdict
    elif top_count > n / 2:
        agreement = "majority"
        multiplier = MULTIPLIER_MAJORITY
        final_verdict = top_verdict
    else:
        agreement = "split"
        multiplier = MULTIPLIER_SPLIT
        # Per spec: split escalates to REVIEW UNLESS every provider says FAIL.
        # (At N=3 a true tie is impossible, so split means a 1-1-1 with all
        # different verdicts; at N=2 it means PASS-vs-FAIL etc.)
        final_verdict = "FAIL" if all(v == "FAIL" for v in verdicts) else "REVIEW"

    avg_conf = sum(r["confidence"] for r in results) / n
    final_confidence = max(0, min(100, int(round(avg_conf * multiplier))))

    summary = " | ".join(
        f"{r['provider']}: {r['summary']}"
        for r in results
        if r["summary"]
    )

    # Issues: union, dedup, preserve first-seen order
    seen: set[str] = set()
    issues: list[str] = []
    for r in results:
        for issue in r["issues"]:
            if issue not in seen:
                seen.add(issue)
                issues.append(issue)

    # Per-check merge: worst status across providers; notes attributed by provider
    merged_checks: dict[str, dict] = {}
    for cat in CHECK_CATEGORIES:
        per_provider = [(r["provider"], r["checks"][cat]) for r in results]
        worst_rank = -1
        worst_status = "skip"
        for _, ck in per_provider:
            rank = STATUS_RANK[ck["status"]]
            if rank > worst_rank:
                worst_rank = rank
                worst_status = ck["status"]

        note_pieces: list[str] = []
        for prov, ck in per_provider:
            if ck["note"] and ck["status"] != "skip":
                note_pieces.append(f"{prov}: {ck['note']}")
        merged_checks[cat] = {
            "status": worst_status,
            "note": " | ".join(note_pieces),
        }

    return final_verdict, final_confidence, agreement, summary, issues, merged_checks


def _build_source_label(succeeded: list[str]) -> str:
    """Return 'triple' | 'dual_<a>_<b>' | '<provider>_only' depending on count."""
    succeeded = sorted(succeeded)  # stable label across runs
    if len(succeeded) == 3:
        return "triple"
    if len(succeeded) == 2:
        return f"dual_{succeeded[0]}_{succeeded[1]}"
    if len(succeeded) == 1:
        return f"{succeeded[0]}_only"
    return "none"  # caller should have raised before reaching this


def _final_envelope(
    *,
    verdict: str,
    confidence: int,
    agreement: str,
    summary: str,
    issues: list[str],
    checks: dict,
    source: str,
    warnings: list[str],
    individual: dict,
) -> dict:
    """Assemble the final response shape per Phase 2 v2.4 §2.4."""
    out: dict[str, Any] = {
        "verdict": verdict,
        "confidence": confidence,
        "agreement": agreement,
        "summary": summary,
        "issues": issues,
        "checks": checks,
        "source": source,
        "individual": individual,
    }
    if warnings:
        out["warnings"] = warnings
    return out


# -----------------------------------------------------------------------------
# Public API — called by arq_worker.process_image when operation="scan"
# -----------------------------------------------------------------------------

async def scan_image(
    *,
    image_gcs_uri: str,
    image_bytes: bytes,
    mime_type: str,
) -> dict:
    """
    Run a parallel triple-provider scan on an uploaded forklift image.

    Args:
        image_gcs_uri: gs://bucket/path of the source image (Gemini reads this directly)
        image_bytes:   raw bytes (used for OpenAI / Anthropic base64 encoding)
        mime_type:     e.g. "image/jpeg" (used by all three providers)

    Returns:
        Merged scan result dict matching the schema in Phase 2 v2.4 §2.4.

    Raises:
        RuntimeError if all available providers fail.
    """
    image_b64 = base64.b64encode(image_bytes).decode("ascii")

    openai_available = _get_openai_client() is not None
    anthropic_available = _get_anthropic_client() is not None

    logger.info(
        "Starting multi-provider scan",
        gcs_uri=image_gcs_uri,
        mime_type=mime_type,
        bytes=len(image_bytes),
        openai=openai_available,
        anthropic=anthropic_available,
    )

    # Build the parallel call list. Gemini always runs.
    coros: list = [_scan_with_gemini(image_gcs_uri=image_gcs_uri, mime_type=mime_type)]
    provider_order: list[str] = ["gemini"]

    if openai_available:
        coros.append(_scan_with_openai(image_b64=image_b64, mime_type=mime_type))
        provider_order.append("openai")
    if anthropic_available:
        coros.append(_scan_with_anthropic(image_b64=image_b64, mime_type=mime_type))
        provider_order.append("anthropic")

    # asyncio.gather with return_exceptions=True so one provider failure
    # doesn't tank the others. Total wall-clock time = max(provider latencies).
    raw = await asyncio.gather(*coros, return_exceptions=True)

    successes: list[dict] = []
    warnings: list[str] = []
    individual: dict[str, Any] = {}

    for provider, result in zip(provider_order, raw):
        if isinstance(result, BaseException):
            err_msg = f"{type(result).__name__}: {result}"
            warnings.append(f"{provider} failed: {err_msg}")
            individual[provider] = {"error": err_msg}
            logger.warning("Provider failed", provider=provider, error=err_msg)
        else:
            successes.append(result)
            # Strip the redundant 'provider' key for the per-provider individual block
            individual[provider] = {k: v for k, v in result.items() if k != "provider"}

    if not successes:
        # All providers failed — surface clearly so the worker marks the job failed
        raise RuntimeError(
            "All providers failed: " + "; ".join(warnings)
        )

    verdict, confidence, agreement, summary, issues, checks = _merge_results(successes)
    source = _build_source_label([r["provider"] for r in successes])

    logger.info(
        "Scan complete",
        verdict=verdict,
        confidence=confidence,
        agreement=agreement,
        source=source,
        warning_count=len(warnings),
    )

    return _final_envelope(
        verdict=verdict,
        confidence=confidence,
        agreement=agreement,
        summary=summary,
        issues=issues,
        checks=checks,
        source=source,
        warnings=warnings,
        individual=individual,
    )
