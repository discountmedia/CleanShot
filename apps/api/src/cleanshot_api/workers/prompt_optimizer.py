"""
Prompt optimizer — condense a long operator prompt without losing what the
pipeline does not supply for it.

WHY THIS EXISTS
---------------
Enhance is prompt-first: whatever the operator types becomes the *spine*, and
`_build_enhance_prompt` appends the toggle extras and the GUARDRAILS block on
top of it. Everything the built-in spine would normally contribute is SKIPPED
(`if spine_override is None:` in enhance_worker).

Nothing truncates a prompt. The full text reaches the image model, and since
2026-08-27 the full text also reaches the differential scanner's "deliberately
requested" whitelist. This is an OPTIMISATION, not a workaround for a cliff.
Three reasons a shorter prompt tends to produce a better image:

  1. Most of the length is already free. The GUARDRAILS block lands on every
     job regardless, so a prompt that re-states "keep the same make and model,
     don't add beacons, keep the decals, don't put it on a white background"
     is paying for text the pipeline appends anyway — and diluting its own
     signal to do it.

  2. Image models respond better to focused declarative scene prose than to
     long multi-section instructional documents. Much of what makes these
     prompts long — placeholder syntax, self-review checklists, the same rule
     phrased three ways — does nothing at all.

  3. The scanner is handed the whole prompt as its whitelist of intended
     edits. The longer and more sprawling that instruction is, the more the
     scanner is told to expect, and the less discriminating the quality check
     becomes. A tight prompt keeps the check sharp.

WHAT IT MUST NOT DO
-------------------
Five blocks live inside `if spine_override is None:` and are therefore NOT
appended when the operator supplies a prompt. Cutting any of them silently
removes it from the model's input. The rubric below carries them as a
protected list, and the response reports `kept` so the operator can see they
survived.

Decal preservation used to be the sixth and most dangerous of these. It became
a GUARDRAIL bullet on 2026-08-27, so it is now appended on every path and a
generic decal sentence in the operator's own text is genuinely redundant. A
SPECIFIC decal instruction is not — see the rubric.

DRIFT-WARNING
-------------
GUARDRAILS_VERBATIM and the protected list below are transcribed from
`_build_enhance_prompt` in workers/enhance_worker.py. If that function's
guardrail bullets or its `spine_override is None` branch change, this rubric
goes stale and the optimizer will start cutting text that is no longer
appended, or keeping text that now is. Re-read that function when you touch it.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Not pinned to JUDGE_MODEL. That pin existed because the judge rubric was
# calibrated against hand labels and a different model invalidated the
# agreement figure. There is no calibration harness for this task, so there is
# nothing to invalidate.
OPTIMIZER_MODEL = "claude-opus-5"

# Generous. The output carries the rewritten prompt PLUS a line-by-line account
# of what was dropped and what was protected, and a truncated account is worse
# than useless — the operator would be approving a diff that isn't the diff.
OPTIMIZER_MAX_TOKENS = 8000

# Bounded well under the BFF's maxDuration so a slow call surfaces as a clean
# error from FastAPI rather than the edge function being killed mid-flight.
OPTIMIZER_TIMEOUT_S = 100.0

# ADVISORY ONLY. Nothing anywhere enforces this — not the save path, not the
# enhance path, not the scanner. It is a rule of thumb for how long a focused
# prompt tends to be once the auto-appended material is taken out, and it gives
# the optimizer something concrete to aim at. Going over is not a failure and
# is never truncated; the operator is told, and decides.
PROMPT_TARGET_CHARS = 1500


# Transcribed verbatim from enhance_worker._build_enhance_prompt. See
# DRIFT-WARNING in the module docstring.
GUARDRAILS_VERBATIM = """\
GUARDRAILS — hard constraints:
• Make, model, year, trim level. <equipment anatomy: same mast configuration,
  fork count, fork length, overhead guard shape, counterweight shape, tire type>
• Every OEM make, model, capacity and safety decal stays exactly as it is: same
  position, same size, same existing wear, still legible. Mask them off during
  the respray rather than painting over them or redrawing the text.
• Do NOT add lamps, beacons, mirrors, antennas, attachments, or any bolt-on
  hardware that is not already in the source.
• Do not introduce damage, dents, broken parts, or wear that was not in the
  source image.
• Never isolate the <equipment> on a white / studio / gradient backdrop. No
  zoom, crop, rotate, horizon-leveling, or re-posing."""


OPTIMIZER_RUBRIC = f"""\
You condense enhancement prompts for a used-forklift dealer's photo pipeline.
The operator writes a prompt; your job is to return a shorter prompt that
produces the SAME image, and to account for every change you made.

## What you are optimising for

Nothing truncates the operator's prompt — long prompts work. You are making it
BETTER, not making it fit. A tighter prompt wins for three reasons: the
guardrails below are appended to every job anyway, image models respond better
to focused scene prose than to long instructional documents, and the automatic
quality checker is given this prompt as its list of expected changes — the more
sprawling it is, the less the check can catch.

Aim for around {PROMPT_TARGET_CHARS} characters. That is a rule of thumb, not a
limit. Going over is fine and is never truncated. Never pad to reach it, and
never drop something from the PROTECTED list to hit it — if the prompt is
already tight, return it nearly unchanged and say so.

## ALWAYS CUT — the pipeline appends this itself, after the operator's text

{GUARDRAILS_VERBATIM}

So cut: keeping the make/model/year/trim; preserving wheel count, fork count,
fork length, mast stages, counterweight or cab structure; generic "keep all the
decals" / "preserve all badges and text" instructions; "don't add lights /
beacons / mirrors / antennas / attachments / bolt-ons"; "don't add damage or
dents that weren't there"; "don't put it on a white / studio / gradient
background"; "don't zoom / crop / rotate / straighten / re-pose".

**The decal exception.** A GENERIC decal-preservation sentence is now covered by
the guardrail and should go. A SPECIFIC one must stay — anything that names a
particular plate, asks for a model number to READ differently, describes a
decal that is damaged or missing, or gives a text change to make. The guardrail
says "keep every decal as it is"; it cannot express "change the 50 to an 80".

## ALSO CUT — these do nothing at all

- Curly-brace placeholders such as {{{{SOURCE_MODEL_TEXT}}}} or
  {{{{TARGET_MODEL_TEXT}}}}. There is no substitution engine. The literal
  braces reach the image model exactly as typed.
- Self-review instructions: "check your output", "verify each item", numbered
  QA checklists, "re-roll if wrong". An image model does not review its own
  output. These are among the largest sections in long prompts and buy nothing.
- Meta-commentary addressed to a human: headers that only organise the
  document, the same rule restated in three phrasings, and preambles about
  what the prompt is for.

## PROTECTED — never cut, never weaken. The pipeline does NOT add these.

When the operator supplies their own prompt, the built-in scene description is
skipped entirely. These five are only present if the operator's text carries
them. Losing one silently degrades every image made from this prompt:

1. TIRE TREATMENT — the tread-versus-sidewall distinction (shine the sidewalls,
   leave the tread dry and matte), and any non-marking / white / light-grey
   tyre carve-out.
2. SCENE AND COMPOSITION — same camera angle, perspective, framing, LIGHTING
   DIRECTION and BACKGROUND ENVIRONMENT. The guardrail covers crop, rotate and
   backdrop-swap only; lighting direction and background environment are not
   covered anywhere else.
3. THE HONESTY BOOKEND — that this is a cheap shop respray, explicitly not a
   restoration and not factory-fresh. This is what stops the result being a
   bait-and-switch listing photo.
4. WHAT THE PAINT DOES NOT COVER — dents, deep gouges, missing or broken parts,
   rust-through and pitting stay visible.
5. PAINT-JOB QUALITY — budget shop finish: slight orange-peel, minor overspray,
   subtle edge buildup.

You may COMPRESS a protected item's wording. You may not remove its meaning.

## REWRITE, don't delete

- NEGATIONS. Emphatic "do NOT change X" phrasing measurably degraded output in
  this pipeline and was reverted in production. Convert each surviving negation
  into the positive outcome. "Do not change the background" becomes "keep the
  existing background". Keep the meaning, drop the prohibition framing.
- BRAND COLOUR NAMES. Never name a manufacturer's colour ("Hyster factory
  yellow", "Toyota grey"). Naming it invites the model to correct a faded or
  repainted unit to what the colour was supposed to be. Rewrite as "its own
  existing colour" or "the colour it already is".

## LEAVE THE TOGGLES ALONE

The Enhance tab has toggles (remove rental branding, remove people, showroom
floor, shine tires, and so on) that append their own text when switched on.
Do NOT cut a sentence because a toggle happens to cover it.

The toggle state is per-batch and the person who loads this template next may
have it switched off — but the template is permanent and cannot be edited. A
prompt that silently depends on a toggle is wrong for everyone after the
author. Treat toggle-covered text as ordinary prompt text: compress it, keep
its meaning.

## OUTPUT

Return the rewritten prompt as a single flowing instruction. Declarative scene
prose outperforms multi-section instructional text here — prefer sentences over
bulleted headers.

Account for your work honestly. `removed` lists what you cut with the reason
(name which rule above licensed it). `kept` lists each PROTECTED item you
carried through, with the phrasing you used, so the operator can confirm none
were lost. If you were forced to cut something you were unsure about, or the
prompt is already tight, say so in `warnings` — an accurate warning is more
useful than a clean-looking result."""


_OPTIMIZER_TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "optimized_prompt": {
            "type": "string",
            "description": "The rewritten prompt, ready to paste into the prompt box.",
        },
        "removed": {
            "type": "array",
            "description": "Everything cut from the original, with the reason.",
            "items": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The cut text, quoted or summarised if long.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Which rule licensed cutting it.",
                    },
                },
                "required": ["text", "reason"],
            },
        },
        "kept": {
            "type": "array",
            "description": "Each PROTECTED item, and the phrasing it survives as.",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["text", "reason"],
            },
        },
        "warnings": {
            "type": "array",
            "description": "Judgement calls the operator should check before saving.",
            "items": {"type": "string"},
        },
    },
    "required": ["optimized_prompt", "removed", "kept", "warnings"],
}


def _as_pairs(value: Any, limit: int = 40) -> list[dict[str, str]]:
    """Coerce a model-supplied list of {text, reason} into a clean list.

    Anthropic does NOT validate tool_use input against the declared schema
    (hard-won lesson #6), so every field here is untrusted. Same defensive
    posture as `_as_int` in enhance_worker: one malformed entry must not 500
    the whole call and lose the operator's optimized prompt along with it.
    """
    out: list[dict[str, str]] = []
    if not isinstance(value, list):
        return out
    for item in value[:limit]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "text": text[:600],
            "reason": str(item.get("reason") or "").strip()[:300],
        })
    return out


async def optimize_prompt(
    anthropic_client: Any,
    body: str,
    *,
    equipment_type: str | None = None,
) -> dict[str, Any]:
    """Condense `body`; return a dict matching OptimizePromptResponse's fields.

    Mirrors the judge's tool-forced-JSON Anthropic pattern (hard-won lesson #6
    — `output_config` is not a valid Messages API parameter here and 400s).
    Read-only: writes nothing, so the caller returns the result inline.
    """
    equipment = (equipment_type or "forklift").replace("_", " ")

    user_text = (
        f"Equipment type for this prompt: {equipment}.\n\n"
        f"The operator's prompt is {len(body):,} characters. Condense it.\n\n"
        f"--- BEGIN OPERATOR PROMPT ---\n{body}\n--- END OPERATOR PROMPT ---"
    )

    response = await anthropic_client.with_options(
        timeout=OPTIMIZER_TIMEOUT_S
    ).messages.create(
        model=OPTIMIZER_MODEL,
        max_tokens=OPTIMIZER_MAX_TOKENS,
        system=OPTIMIZER_RUBRIC,
        tools=[
            {
                "name": "report_optimized_prompt",
                "description": (
                    "Submit the condensed prompt together with a full account "
                    "of what was removed and what was protected."
                ),
                "input_schema": _OPTIMIZER_TOOL_SCHEMA,
            }
        ],
        tool_choice={"type": "tool", "name": "report_optimized_prompt"},
        messages=[{"role": "user", "content": user_text}],
    )

    tool_block = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_block is None:
        # tool_choice forces the call, so this means the turn ended some other
        # way (a refusal, or max_tokens before the block closed). Surface it as
        # a failure rather than returning an empty prompt the operator might
        # save over a working one.
        raise ValueError(
            f"Optimizer returned no tool_use block (stop_reason="
            f"{getattr(response, 'stop_reason', 'unknown')})"
        )

    result = tool_block.input if isinstance(tool_block.input, dict) else {}

    optimized = str(result.get("optimized_prompt") or "").strip()
    if not optimized:
        raise ValueError("Optimizer returned an empty prompt")

    warnings_raw = result.get("warnings")
    warnings = [
        str(w).strip()[:300]
        for w in (warnings_raw if isinstance(warnings_raw, list) else [])
        if str(w).strip()
    ][:20]

    logger.info(
        "prompt_optimize model=%s in=%d out=%d removed=%d kept=%d",
        OPTIMIZER_MODEL,
        len(body),
        len(optimized),
        len(_as_pairs(result.get("removed"))),
        len(_as_pairs(result.get("kept"))),
    )

    return {
        "optimized_prompt": optimized,
        "original_chars": len(body),
        "optimized_chars": len(optimized),
        "target_chars": PROMPT_TARGET_CHARS,
        "removed": _as_pairs(result.get("removed")),
        "kept": _as_pairs(result.get("kept")),
        "warnings": warnings,
    }
