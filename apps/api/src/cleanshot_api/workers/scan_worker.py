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

SCAN_SYSTEM_PROMPT = """You are a quality control inspector for forklift images.
Analyse the provided forklift image and return a structured JSON assessment.

Evaluate:
1. Overall image quality (lighting, focus, composition)
2. Physical condition of the forklift (rust, damage, missing parts, worn components)
3. Data plate and safety label legibility
4. Background appropriateness for commercial use
5. Any anomalies that would affect resale value or safety compliance

Return ONLY valid JSON matching the ScanResult schema. No preamble or explanation."""


async def _scan_gemini(
    genai_client: Any,
    gcs_uri: str,
) -> tuple[ScanResult, int]:
    """Gemini scan — uses GCS URI directly (no base64 transfer)."""
    t0 = time.monotonic()
    # Gemini file_data requires mime_type. Derive from filename in URI.
    mime_type = mimetypes.guess_type(gcs_uri)[0] or "image/jpeg"
    file_part = types.Part.from_uri(file_uri=gcs_uri, mime_type=mime_type)
    text_part = types.Part.from_text(text=SCAN_SYSTEM_PROMPT)
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
) -> tuple[ScanResult, int]:
    """OpenAI scan — Responses API with gpt-5.4, data URL WITH prefix."""
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    b64 = base64.b64encode(image_bytes).decode()
    data_url = f"data:{ct};base64,{b64}"

    t0 = time.monotonic()
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
                    {"type": "input_text", "text": SCAN_SYSTEM_PROMPT},
                ],
            }
        ],
        text={
            "format": {
                "type": "json_schema",
                "name": "ScanResult",
                "schema": ScanResult.model_json_schema(),
                "strict": True,
            }
        },
    )
    latency_ms = int((time.monotonic() - t0) * 1000)
    result: ScanResult = response.output_parsed
    return result, latency_ms


async def _scan_anthropic(
    anthropic_client: Any,
    gcs_uri: str,
    difficulty: str,
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
                    },
                    {"type": "text", "text": SCAN_SYSTEM_PROMPT},
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

    try:
        provider_results: dict[str, ScanResult] = {}
        provider_latencies: dict[str, int] = {}

        async with asyncio.TaskGroup() as tg:
            # Gemini always active
            async def _gemini() -> None:
                r, lat = await _scan_gemini(genai_client, payload.input_gcs_uri)
                provider_results["gemini"] = r
                provider_latencies["gemini"] = lat

            tg.create_task(_gemini())

            if settings.scan_provider_openai and openai_client:
                async def _openai() -> None:
                    r, lat = await _scan_openai(openai_client, payload.input_gcs_uri)
                    provider_results["openai"] = r
                    provider_latencies["openai"] = lat

                tg.create_task(_openai())

            if settings.scan_provider_anthropic and anthropic_client:
                async def _anthropic() -> None:
                    r, lat = await _scan_anthropic(
                        anthropic_client,
                        payload.input_gcs_uri,
                        payload.scan_difficulty,
                    )
                    provider_results["anthropic"] = r
                    provider_latencies["anthropic"] = lat

                tg.create_task(_anthropic())

        # Persist per-provider results
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

            # Persist consensus (even for single-provider)
            consensus = _compute_consensus(provider_results)
            await queries.create_consensus_result(
                conn,
                job_id=payload.job_id,
                asset_id=payload.input_asset_id,
                **consensus,
            )

            await queries.update_job_status(conn, payload.job_id, JobStatusEnum.complete)

        logger.info(
            "Scan complete for job %s | providers=%s | verdict=%s",
            payload.job_id,
            list(provider_results.keys()),
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
