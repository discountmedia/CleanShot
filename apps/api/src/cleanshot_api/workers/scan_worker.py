"""
Scan worker — multi-model fan-out with asyncio.TaskGroup.

Provider routing (Phase 2 v2.5):
  Primary:           gemini-2.5-flash  (always active)
  Optional OpenAI:   gpt-5.4                         (SCAN_PROVIDER_OPENAI=true)
  Optional Anthropic: claude-sonnet-4-6              (SCAN_PROVIDER_ANTHROPIC=true)
                    → claude-opus-4-7 for hard scans

Image input format differences:
  Gemini:    GCS URI via file_data.file_uri (no base64 needed)
  OpenAI:    data URL WITH prefix  ("data:image/jpeg;base64,...")
  Anthropic: raw base64 WITHOUT prefix

Consensus logic:
  1 provider:  verdict = that provider's verdict
  2 providers: majority or split
  3 providers: majority (2/3). If 1:1:1 across pass/fail/split → "split"
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import time
import uuid
from typing import Any

from fastapi import BackgroundTasks, Request
from google.genai import types

from cleanshot_api.core.config import get_settings
from cleanshot_api.db import queries
from cleanshot_api.models.schemas import (
    AnomalyItem,
    JobStatusEnum,
    OperationEnum,
    ScanResult,
    ScanTaskPayload,
)

logger = logging.getLogger(__name__)

SCAN_MODEL_GEMINI = "gemini-2.5-flash"
SCAN_MODEL_OPENAI = "gpt-5.4"
SCAN_MODEL_ANTHROPIC_STD = "claude-sonnet-4-6"
SCAN_MODEL_ANTHROPIC_HARD = "claude-opus-4-7"  # 3× vision resolution

SCAN_SYSTEM_PROMPT_BASE = """You are the FINAL quality-control gate for AI-ENHANCED equipment listing photos. Each image was produced by an image-editing AI from a real photo of a used machine (forklift, telehandler, scissor lift, etc.). You exist as a cover-your-ass check against SERIOUS, OBVIOUS AI failures that would embarrass the company or mislead a buyer if the photo went live. You are NOT a photo critic and NOT a perfectionist.

DEFAULT TO "pass". Only return "fail" when the image has a GROSS, UNMISTAKABLE generation defect that a normal customer would immediately notice as wrong or fake. If the image looks good enough to put on a listing, it passes. Minor imperfections are expected and acceptable — they are not failures.

Return "fail" ONLY for serious, obvious defects like these:
1. Duplicated or extra major parts — two seats, two steering wheels, a second mast, extra forks, an extra wheel, a duplicated operator cage.
2. Missing or destroyed major parts — forks gone where forks belong, a wheel missing, the mast or overhead guard structurally broken or dissolved.
3. Grossly warped, melted, or fused structure — the chassis, mast, or forks obviously bent, melted, or merged in a way no real machine could be.
4. Text turned into obvious gibberish — an OEM badge, capacity plate, or decal rendered as scrambled nonsense letters that plainly reads as fake.
5. Wildly wrong colour — the whole machine or a major panel painted a colour that is obviously not real (e.g. a forklift turned bright purple).
6. Hallucinated objects fused to the machine — phantom equipment, random objects, or extra hardware grafted onto the unit that was never in the real photo.
7. Mangled people — if a person is visible: extra limbs, fused hands, or a distorted face.

DO NOT FLAG these — they are NOT failures, and you must NOT mention them at all:
- Minor or subtle warped geometry, slight asymmetry, or small perspective skew that still looks like a real machine. Only call out geometry when it is grossly, obviously broken.
- Text that is slightly soft, slightly blurry, or only partially legible but still plausible. Only call out text when it is obvious scrambled nonsense.
- Subtle colour shifts, reflections, or minor panel-tone differences.
- ANY photography quality: lighting, angle, composition, exposure, focus, sharpness, framing, background choice, shadows, or how flattering the shot is. This is explicitly not your job and the operator does not want it.
- Real dirt, wear, scratches, or rust actually on the used machine.
- Anything that is merely "could be a little better" rather than "obviously broken or fake".

Do NOT give advice, suggestions, or photography tips of any kind — not in the summary, not in the anomalies. If there is no serious defect, return verdict "pass" with an empty anomalies list and a one-sentence summary. Only ever populate anomalies with serious (medium- or high-severity) generation defects from the list above; never with nitpicks.

Return ONLY valid JSON matching the ScanResult schema. No preamble or explanation."""


def _build_scan_prompt(equipment_type: str | None, make: str | None) -> str:
    """
    Append known-equipment context to the base prompt so the inspector
    judges anatomy against the RIGHT machine. Knowing the unit is e.g. a
    scissor lift (which has no forks) prevents a big class of false
    "missing/warped part" flags — directly addressing the operator's
    complaint about over-eager geometry warnings.
    """
    ctx_lines: list[str] = []
    if equipment_type:
        label = equipment_type.replace("_", " ").strip()
        if label:
            ctx_lines.append(
                f"- This unit is a {label}. Judge its anatomy by what a real "
                f"{label} actually has; never flag a part as missing or wrong "
                f"that this equipment type does not normally have."
            )
    if make and make.strip():
        ctx_lines.append(
            f'- Stated make: "{make.strip()}". Only flag colour when it is '
            f"wildly, obviously wrong — not for subtle brand-palette differences."
        )
    if not ctx_lines:
        return SCAN_SYSTEM_PROMPT_BASE
    return (
        f"{SCAN_SYSTEM_PROMPT_BASE}\n\nKNOWN EQUIPMENT CONTEXT:\n"
        + "\n".join(ctx_lines)
    )


# Backwards-compatible default (no equipment context) for any caller that
# still imports the bare prompt.
SCAN_SYSTEM_PROMPT = SCAN_SYSTEM_PROMPT_BASE


async def _scan_gemini(
    genai_client: Any,
    gcs_uri: str,
    system_prompt: str,
) -> tuple[ScanResult, int]:
    """Gemini scan — uses GCS URI directly (no base64 transfer)."""
    t0 = time.monotonic()
    # Gemini file_data requires mime_type. Derive from filename in URI.
    mime_type = mimetypes.guess_type(gcs_uri)[0] or "image/jpeg"
    file_part = types.Part.from_uri(file_uri=gcs_uri, mime_type=mime_type)
    text_part = types.Part.from_text(text=system_prompt)
    response = await genai_client.aio.models.generate_content(
        model=SCAN_MODEL_GEMINI,
        contents=[
            types.Content(role="user", parts=[file_part, text_part])
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ScanResult,
        ),
    )
    latency_ms = int((time.monotonic() - t0) * 1000)
    result = ScanResult.model_validate_json(response.text)
    return result, latency_ms


async def _load_image_bytes(gcs_uri: str) -> tuple[bytes, str]:
    """Download image bytes from GCS for providers that need base64.
    Runs the sync GCS download in a thread to avoid blocking the event loop.
    """
    from google.cloud import storage as gcs

    settings = get_settings()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    def _download() -> bytes:
        client = gcs.Client(project=settings.gcp_project)
        blob = client.bucket(bucket_name).blob(object_name)
        return blob.download_as_bytes()

    data = await asyncio.to_thread(_download)

    # Detect content type from first bytes
    ct = "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        ct = "image/png"
    elif data[:4] == b"RIFF":
        ct = "image/webp"
    return data, ct


async def _scan_openai(
    openai_client: Any,
    gcs_uri: str,
    system_prompt: str,
) -> tuple[ScanResult, int]:
    """OpenAI scan — Responses API with gpt-5.4, data URL WITH prefix."""
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    b64 = base64.b64encode(image_bytes).decode()
    data_url = f"data:{ct};base64,{b64}"

    t0 = time.monotonic()
    # Pass the Pydantic model as text_format — the SDK converts it to a
    # strict-mode-compliant JSON schema (adds additionalProperties:false,
    # marks all fields required, etc.). Hand-rolling .model_json_schema()
    # produces a schema OpenAI rejects with 'additionalProperties is
    # required to be supplied and to be false'.
    response = await openai_client.responses.parse(
        model=SCAN_MODEL_OPENAI,
        input=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_image",
                        "image_url": data_url,  # WITH prefix — OpenAI requirement
                        "detail": "high",
                    },
                    {"type": "input_text", "text": system_prompt},
                ],
            }
        ],
        text_format=ScanResult,
    )
    latency_ms = int((time.monotonic() - t0) * 1000)
    result: ScanResult = response.output_parsed
    return result, latency_ms


async def _scan_anthropic(
    anthropic_client: Any,
    gcs_uri: str,
    difficulty: str,
    system_prompt: str,
) -> tuple[ScanResult, int]:
    """
    Anthropic scan — tool-forced JSON via tool_choice. Raw base64 WITHOUT prefix.
    Routes to claude-opus-4-7 for hard scans (3× vision resolution).
    """
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    b64 = base64.b64encode(image_bytes).decode()  # NO data: prefix — Anthropic requirement

    model_id = (
        SCAN_MODEL_ANTHROPIC_HARD
        if difficulty == "hard"
        else SCAN_MODEL_ANTHROPIC_STD
    )

    t0 = time.monotonic()
    response = await anthropic_client.messages.create(
        model=model_id,
        max_tokens=3048,
        system=system_prompt,
        tools=[
            {
                "name": "report_scan",
                "description": "Submit the structured forklift QC scan assessment.",
                "input_schema": ScanResult.model_json_schema(),
            }
        ],
        tool_choice={"type": "tool", "name": "report_scan"},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": ct,
                            "data": b64,  # Raw base64, no prefix
                        },
                    }
                ],
            }
        ],
    )
    latency_ms = int((time.monotonic() - t0) * 1000)
    # tool_choice forces a tool_use block; model's args land in .input as a dict.
    tool_block = next(b for b in response.content if b.type == "tool_use")
    result = ScanResult.model_validate(tool_block.input)
    return result, latency_ms


def _compute_consensus(
    provider_results: dict[str, ScanResult],
) -> dict[str, Any]:
    """
    Consensus: majority vote. 'split' when no majority.
    Returns the dict shape needed by create_consensus_result.
    """
    verdicts = [r.verdict for r in provider_results.values()]
    pass_count = verdicts.count("pass")
    fail_count = verdicts.count("fail")
    provider_count = len(verdicts)

    if pass_count > fail_count:
        consensus_verdict = "pass"
    elif fail_count > pass_count:
        consensus_verdict = "fail"
    else:
        consensus_verdict = "split"

    # Average confidence
    confidence = sum(r.confidence for r in provider_results.values()) / provider_count

    # Divergent providers are those whose verdict ≠ consensus_verdict
    # (only relevant when consensus is not "split")
    divergent = [
        p for p, r in provider_results.items()
        if r.verdict != consensus_verdict
    ]

    # Merge anomalies: deduplicate by type+location
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    high_conf: list[dict[str, Any]] = []
    for result in provider_results.values():
        for a in result.anomalies:
            key = f"{a.type}:{a.location}"
            if key not in seen:
                seen.add(key)
                d = a.model_dump()
                merged.append(d)
                if a.severity == "high":
                    high_conf.append(d)

    return {
        "verdict": consensus_verdict,
        "confidence": round(confidence, 4),
        "provider_count": provider_count,
        "pass_count": pass_count,
        "fail_count": fail_count,
        "unanimous": len(set(verdicts)) == 1,
        "divergent_providers": divergent,
        "merged_anomalies": merged,
        "high_confidence_anomalies": high_conf,
    }


async def _run_scan(
    request: Request,
    payload: ScanTaskPayload,
) -> None:
    pool = request.app.state.pool
    genai_client = request.app.state.genai
    openai_client = request.app.state.openai
    anthropic_client = request.app.state.anthropic
    settings = get_settings()

    async with pool.acquire() as conn:
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    # Equipment context (if the operator filled in the meta fields) sharpens
    # the inspector's anatomy judgement and cuts false geometry/colour flags.
    system_prompt = _build_scan_prompt(payload.equipment_type, payload.make)

    try:
        provider_results:   dict[str, ScanResult] = {}
        provider_latencies: dict[str, int]        = {}
        provider_errors:    dict[str, str]        = {}

        # Per-provider failures must NOT tank the whole job — multi-model
        # scan is the whole point of this worker, and a single 429 from
        # one vendor shouldn't cost the operator the other vendors'
        # verdicts. asyncio.TaskGroup is the wrong primitive here
        # because it cancels every sibling on first exception (root
        # cause of the "Gemini: fail/0%/0ms, OpenAI/Anthropic stuck
        # pending" bug). asyncio.gather(return_exceptions=True) gives
        # us independent task lifecycles + lets each provider's outcome
        # land in its own bucket.
        async def _safe_gemini() -> None:
            try:
                r, lat = await _scan_gemini(genai_client, payload.input_gcs_uri, system_prompt)
                provider_results["gemini"]   = r
                provider_latencies["gemini"] = lat
            except Exception as exc:
                logger.exception("Gemini scan failed for job %s", payload.job_id)
                provider_errors["gemini"] = str(exc)[:300]

        async def _safe_openai() -> None:
            try:
                r, lat = await _scan_openai(openai_client, payload.input_gcs_uri, system_prompt)
                provider_results["openai"]   = r
                provider_latencies["openai"] = lat
            except Exception as exc:
                logger.exception("OpenAI scan failed for job %s", payload.job_id)
                provider_errors["openai"] = str(exc)[:300]

        async def _safe_anthropic() -> None:
            try:
                r, lat = await _scan_anthropic(
                    anthropic_client,
                    payload.input_gcs_uri,
                    payload.scan_difficulty,
                    system_prompt,
                )
                provider_results["anthropic"]   = r
                provider_latencies["anthropic"] = lat
            except Exception as exc:
                logger.exception("Anthropic scan failed for job %s", payload.job_id)
                provider_errors["anthropic"] = str(exc)[:300]

        coros: list = [_safe_gemini()]
        if settings.scan_provider_openai and openai_client:
            coros.append(_safe_openai())
        if settings.scan_provider_anthropic and anthropic_client:
            coros.append(_safe_anthropic())

        # return_exceptions=True is belt-and-braces — every _safe_*
        # already swallows its own exception, but if anything slips
        # through it'll land here as a value rather than propagating.
        await asyncio.gather(*coros, return_exceptions=True)

        # No successful providers → whole job is failed.
        if not provider_results:
            err_summary = "; ".join(
                f"{p}: {msg}" for p, msg in provider_errors.items()
            ) or "no providers configured"
            async with pool.acquire() as conn:
                await queries.update_job_status(
                    conn,
                    payload.job_id,
                    JobStatusEnum.failed,
                    error=f"all scan providers failed — {err_summary}"[:500],
                )
            logger.error(
                "Scan job %s failed — every provider errored: %s",
                payload.job_id, provider_errors,
            )
            return

        # Persist successful per-provider results AND failure rows so the
        # UI can show "<provider> — failed: <reason>" instead of leaving
        # that provider stuck on "pending" forever.
        async with pool.acquire() as conn:
            for provider, result in provider_results.items():
                await queries.create_scan_result(
                    conn,
                    job_id=payload.job_id,
                    asset_id=payload.input_asset_id,
                    provider=provider,
                    verdict=result.verdict,
                    confidence=result.confidence,
                    anomalies=[a.model_dump() for a in result.anomalies],
                    summary=result.summary,
                    latency_ms=provider_latencies[provider],
                )
            for provider, err_msg in provider_errors.items():
                await queries.create_scan_result(
                    conn,
                    job_id=payload.job_id,
                    asset_id=payload.input_asset_id,
                    provider=provider,
                    verdict="fail",
                    confidence=0.0,
                    anomalies=[],
                    summary=f"provider error: {err_msg}",
                    latency_ms=0,
                )

            # Consensus is computed over the providers that DID respond.
            consensus = _compute_consensus(provider_results)
            await queries.create_consensus_result(
                conn,
                job_id=payload.job_id,
                asset_id=payload.input_asset_id,
                **consensus,
            )

            await queries.update_job_status(conn, payload.job_id, JobStatusEnum.complete)

        logger.info(
            "Scan complete for job %s | providers=%s | failed=%s | verdict=%s",
            payload.job_id,
            list(provider_results.keys()),
            list(provider_errors.keys()),
            consensus["verdict"],
        )

    except Exception as exc:
        logger.exception("Scan worker failed for job %s", payload.job_id)
        async with pool.acquire() as conn:
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.failed,
                error=str(exc)[:500],
            )


async def handle_scan_task(
    payload: ScanTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """Quick-acknowledge then fan-out to all active scan providers."""
    background_tasks.add_task(_run_scan, request, payload)
    return {"status": "acknowledged"}