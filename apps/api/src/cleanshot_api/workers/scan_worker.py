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
- Fresh paint or a glossy respray of any kind. Red or orange FORKS with YELLOW TIPS, a BLACK backrest / fork carriage / load guard, and a cleanly repainted body are all normal, real equipment finishes that this tool applies on purpose. Never flag paint.
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


# ---------------------------------------------------------------------------
# DIFFERENTIAL scan — compare the ENHANCED output against the ORIGINAL photo.
#
# The isolated scan above judges one image in a vacuum and is deliberately
# blind to altered geometry (to keep false positives down). That blindness is
# exactly what let a silent "72-inch forks → 32-inch forks" edit ship. When we
# have the original photo, "spot the difference" is a far more grounded task:
# the original IS the spec, so dimensional drift, added damage/debris, and
# altered model numbers all surface as differences instead of requiring the
# model to guess correctness from nothing. Intended edits (repaint, de-brand,
# remove people) are passed in as a whitelist so we don't flag them.
# ---------------------------------------------------------------------------
SCAN_DIFFERENTIAL_PROMPT_BASE = """You are the FINAL quality-control gate for AI-ENHANCED equipment listing photos. You are shown TWO images of the SAME piece of used equipment:
  • IMAGE 1 = the ORIGINAL real photo (the ground truth for what the machine actually looks like).
  • IMAGE 2 = the AI-ENHANCED output produced from Image 1.

Image 2 is SUPPOSED to look different from Image 1 — it has been deliberately cleaned up and repainted for a sales listing. Your ONLY job is the narrow case where the AI misrepresented the MACHINE'S HARDWARE: it changed what the buyer is actually buying. If Image 2 shows the same machine with the same parts at the same size, it PASSES — no matter how much better it looks.

CHANGES THAT ARE EXPECTED — never flag these, and never mention them at all:
- PAINT AND COLOUR. Fresh paint, a glossy respray, richer colour, and cleaner panels are the POINT of this tool. Always expected:
    • Body, cab, or mast resprayed in the machine's own colour family — a brighter, cleaner, or slightly different shade of the same colour.
    • FORKS painted RED (or orange, or black), with or without YELLOW TIPS.
    • The backrest, fork carriage, or load guard rendered BLACK.
    • Wheels, rims, counterweight, or trim repainted in normal equipment colours.
  A repaint is NEVER a defect. Do not report any anomaly for paint.
- Lighting, exposure, brightness, contrast, white balance, saturation, or overall colour grade.
- Background, floor, or surroundings being cleaned, replaced, or simplified.
- Reflections, shadows, glare, general cleanliness, removal of dirt, dust, rust, or scuffs.
- Sharpness, resolution, crop, or framing/zoom differences.
- Small shape or proportion differences that still read as the same part — slight taper, thickness, edge, or angle variation. Only an obvious size change matters (see #1).
- Model, capacity, or badge text that is slightly softer or off by a character or two but still reads as essentially the same marking.
- Any edit listed under "REQUESTED EDITS" below.

CHANGES THAT ARE DEFECTS — flag these ONLY when they are obvious at a glance and would mislead a buyer:
1. SIZE MISREPRESENTED — the forks, mast, boom, wheels, or platform are plainly a different size than the real ones (forks roughly half their real length, the mast gaining or losing a section, wheels obviously larger). A buyer relies on the photo matching the real spec, so an obvious size change is the single most important thing you catch. Clear, at-a-glance differences only — never subtle ones.
2. PARTS ADDED OR REMOVED — a whole fork, wheel, mirror, light, guard, hose, seat, or attachment present in one image and absent in the other. An extra wheel or a missing fork is a defect; a small bracket you can barely make out is not.
3. DAMAGE ADDED — new dents, cracks, holes, or heavy rust that were NOT on the real machine. The enhancer must never make the unit look MORE damaged than it is.
4. MAJOR TEXT REPLACED — a clearly legible model number, capacity rating, or OEM badge that now reads as a genuinely DIFFERENT value (e.g. "8FGU25" became "8FGU45"; "5000 LB" became "9000 LB"). Only when the text is legible in BOTH images and the value truly differs. Never flag soft, partially-legible, or one-or-two-character differences.
5. WRONG-MACHINE COLOUR — the body, cab, or mast is a plainly DIFFERENT colour than the real machine (an orange unit turned blue), or the whole machine is washed out and desaturated to look grey and lifeless. This is about misidentifying the machine, NOT about repainting it — see the paint rule above.
6. HALLUCINATED OR MANGLED CONTENT — phantom objects fused onto the machine, a duplicated cab or mast, or a visible person with extra limbs or a distorted face.

Compare the two images part by part, then apply this test: "would a buyer who saw the real machine in person feel this photo misled them about the hardware?" If no, return "pass".

DEFAULT TO "pass". Return "fail" only when at least one obvious defect above is present. Never report a change you had to look hard to notice. Never critique photography, composition, or how flattering the shot is, and never give advice or tips. If the only differences are cleanup, paint, or requested edits, return "pass" with empty anomalies.

Return ONLY valid JSON matching the ScanResult schema. No preamble or explanation."""


def _build_differential_prompt(
    equipment_type: str | None,
    make: str | None,
    intended_edits: list[str] | None,
) -> str:
    """
    Assemble the differential (before/after) scan prompt: base rubric +
    equipment context + the whitelist of edits the enhance step was asked
    to make (so deliberate changes aren't flagged as defects).
    """
    sections: list[str] = [SCAN_DIFFERENTIAL_PROMPT_BASE]

    ctx_lines: list[str] = []
    if equipment_type:
        label = equipment_type.replace("_", " ").strip()
        if label:
            ctx_lines.append(
                f"- Both images show a {label}. Judge only parts a real "
                f"{label} actually has; do not expect a part this equipment "
                f"type does not have."
            )
    if make and make.strip():
        ctx_lines.append(f'- Stated make: "{make.strip()}".')
    if ctx_lines:
        sections.append("KNOWN EQUIPMENT CONTEXT:\n" + "\n".join(ctx_lines))

    if intended_edits:
        edits = "\n".join(f"- {e}" for e in intended_edits)
        sections.append(
            "REQUESTED EDITS (these were asked for — treat as EXPECTED, do NOT "
            "flag them):\n" + edits
        )
    else:
        # NOTE: this fallback must NOT be stricter than the base rubric. It
        # fires on the manual Scan-tab re-scan (which sends no whitelist) and
        # on prompt-first enhances where every toggle was left off — i.e. the
        # common case, not the exception. The old wording here ("treat any
        # change to the machine's physical form ... as unintended") is what
        # turned every requested repaint into a colour_changed false positive.
        sections.append(
            "REQUESTED EDITS: none itemised for this image. Standard listing "
            "cleanup AND repainting are still assumed and expected — judge "
            "only the hardware rules above."
        )

    return "\n\n".join(sections)


async def _scan_gemini(
    genai_client: Any,
    gcs_uri: str,
    system_prompt: str,
    original_gcs_uri: str | None = None,
) -> tuple[ScanResult, int]:
    """
    Gemini scan — uses GCS URI directly (no base64 transfer).

    When original_gcs_uri is set, runs DIFFERENTIAL: the original photo is
    sent as IMAGE 1 and the enhanced output as IMAGE 2, with text labels so
    the model knows which is which (Gemini honours part order).
    """
    t0 = time.monotonic()
    # Gemini file_data requires mime_type. Derive from filename in URI.
    mime_type = mimetypes.guess_type(gcs_uri)[0] or "image/jpeg"
    enhanced_part = types.Part.from_uri(file_uri=gcs_uri, mime_type=mime_type)
    text_part = types.Part.from_text(text=system_prompt)

    if original_gcs_uri:
        orig_mime = mimetypes.guess_type(original_gcs_uri)[0] or "image/jpeg"
        orig_part = types.Part.from_uri(file_uri=original_gcs_uri, mime_type=orig_mime)
        parts = [
            types.Part.from_text(text="IMAGE 1 — ORIGINAL real photo:"),
            orig_part,
            types.Part.from_text(text="IMAGE 2 — AI-ENHANCED output to inspect:"),
            enhanced_part,
            text_part,
        ]
    else:
        parts = [enhanced_part, text_part]

    response = await genai_client.aio.models.generate_content(
        model=SCAN_MODEL_GEMINI,
        contents=[types.Content(role="user", parts=parts)],
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
    original_gcs_uri: str | None = None,
) -> tuple[ScanResult, int]:
    """
    OpenAI scan — Responses API with gpt-5.4, data URL WITH prefix.

    When original_gcs_uri is set, runs DIFFERENTIAL: both images go into the
    same content array (multiple input_image items are supported), labeled by
    interleaved input_text so the model can tell original from enhanced.
    """
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    b64 = base64.b64encode(image_bytes).decode()
    data_url = f"data:{ct};base64,{b64}"

    content: list[dict[str, Any]] = []
    if original_gcs_uri:
        orig_bytes, orig_ct = await _load_image_bytes(original_gcs_uri)
        orig_b64 = base64.b64encode(orig_bytes).decode()
        orig_url = f"data:{orig_ct};base64,{orig_b64}"
        content.append({"type": "input_text", "text": "IMAGE 1 — ORIGINAL real photo:"})
        content.append({"type": "input_image", "image_url": orig_url, "detail": "high"})
        content.append({"type": "input_text", "text": "IMAGE 2 — AI-ENHANCED output to inspect:"})
        content.append({"type": "input_image", "image_url": data_url, "detail": "high"})
    else:
        content.append({"type": "input_image", "image_url": data_url, "detail": "high"})
    content.append({"type": "input_text", "text": system_prompt})

    t0 = time.monotonic()
    # Pass the Pydantic model as text_format — the SDK converts it to a
    # strict-mode-compliant JSON schema (adds additionalProperties:false,
    # marks all fields required, etc.). Hand-rolling .model_json_schema()
    # produces a schema OpenAI rejects with 'additionalProperties is
    # required to be supplied and to be false'.
    response = await openai_client.responses.parse(
        model=SCAN_MODEL_OPENAI,
        input=[{"role": "user", "content": content}],
        text_format=ScanResult,
    )
    latency_ms = int((time.monotonic() - t0) * 1000)
    result: ScanResult = response.output_parsed
    return result, latency_ms


def _anthropic_image_block(ct: str, b64: str) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": ct,
            "data": b64,  # Raw base64, no prefix — Anthropic requirement
        },
    }


async def _scan_anthropic(
    anthropic_client: Any,
    gcs_uri: str,
    difficulty: str,
    system_prompt: str,
    original_gcs_uri: str | None = None,
) -> tuple[ScanResult, int]:
    """
    Anthropic scan — tool-forced JSON via tool_choice. Raw base64 WITHOUT prefix.
    Routes to claude-opus-4-7 for hard scans (3× vision resolution).

    When original_gcs_uri is set, runs DIFFERENTIAL: both images are added as
    image blocks with text labels between them (Anthropic's documented
    multi-image pattern), original first then enhanced.
    """
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    b64 = base64.b64encode(image_bytes).decode()  # NO data: prefix — Anthropic requirement

    model_id = (
        SCAN_MODEL_ANTHROPIC_HARD
        if difficulty == "hard"
        else SCAN_MODEL_ANTHROPIC_STD
    )

    if original_gcs_uri:
        orig_bytes, orig_ct = await _load_image_bytes(original_gcs_uri)
        orig_b64 = base64.b64encode(orig_bytes).decode()
        content: list[dict[str, Any]] = [
            {"type": "text", "text": "IMAGE 1 — ORIGINAL real photo:"},
            _anthropic_image_block(orig_ct, orig_b64),
            {"type": "text", "text": "IMAGE 2 — AI-ENHANCED output to inspect:"},
            _anthropic_image_block(ct, b64),
        ]
    else:
        content = [_anthropic_image_block(ct, b64)]

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
        messages=[{"role": "user", "content": content}],
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

    # DIFFERENTIAL mode fires whenever the enqueuer handed us the original
    # pre-enhance photo. Then we compare enhanced-vs-original ("what changed?")
    # instead of judging the output in a vacuum — which is what catches silent
    # dimensional drift (shrunk forks) and added damage. No original (standalone
    # uploads) → the legacy isolated CYA scan.
    is_differential = bool(payload.original_gcs_uri)
    if is_differential:
        system_prompt = _build_differential_prompt(
            payload.equipment_type, payload.make, payload.intended_edits
        )
    else:
        # Equipment context (if the operator filled in the meta fields) sharpens
        # the inspector's anatomy judgement and cuts false geometry/colour flags.
        system_prompt = _build_scan_prompt(payload.equipment_type, payload.make)
    original_uri = payload.original_gcs_uri  # None in isolated mode

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
                r, lat = await _scan_gemini(
                    genai_client, payload.input_gcs_uri, system_prompt, original_uri
                )
                provider_results["gemini"]   = r
                provider_latencies["gemini"] = lat
            except Exception as exc:
                logger.exception("Gemini scan failed for job %s", payload.job_id)
                provider_errors["gemini"] = str(exc)[:300]

        async def _safe_openai() -> None:
            try:
                r, lat = await _scan_openai(
                    openai_client, payload.input_gcs_uri, system_prompt, original_uri
                )
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
                    original_uri,
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
            "Scan complete for job %s | mode=%s | providers=%s | failed=%s | verdict=%s",
            payload.job_id,
            "differential" if is_differential else "isolated",
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