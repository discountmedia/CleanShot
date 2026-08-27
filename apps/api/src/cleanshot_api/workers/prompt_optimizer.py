"""
Prompt optimizer — condense a long operator prompt without losing what the
pipeline does not supply for it.

WHY THIS EXISTS
---------------
Enhance is prompt-first: whatever the operator types becomes the *spine*, and
`_build_enhance_prompt` appends the toggle extras and the GUARDRAILS block on
top of it. Everything the built-in spine would normally contribute is SKIPPED
(`if spine_override is None:` — enhance_worker.py:561).

Two consequences drive this whole module:

  1. Long prompts get silently half-ignored by the differential scanner. The
     operator's instruction is passed into the scanner's "intended edits"
     whitelist sliced at SCANNER_INTENT_WHITELIST_CHARS
     (enhance_worker.py `_describe_intended_edits`). Past that cut, the
     operator's OWN requested edits stop being whitelisted and start coming
     back as reported anomalies. A 9,700-character template is ~84% invisible
     to that whitelist.

  2. Much of what makes those prompts long is already appended for free. The
     GUARDRAILS block always lands on the prompt-first path, so a prompt that
     re-states "keep the same make and model, don't add beacons, don't put it
     on a white background" is paying characters for text the pipeline adds
     anyway — and spending them out of the 1500 the scanner can see.

So the optimizer's objective is NOT "shorter". It is "fit inside the scanner
whitelist while still carrying everything the pipeline will not add for you".

WHAT IT MUST NOT DO
-------------------
Six blocks live inside `if spine_override is None:` and are therefore NOT
appended when the operator supplies a prompt. Cutting any of them silently
removes it from the model's input entirely. Decal preservation is the one that
looks most redundant and is not — PROMPT-HYSTER.md:95-99 records exactly that
mistake being made and caught. The rubric below carries all six as a protected
list, and the response reports `kept` so the operator can see they survived.

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

from cleanshot_api.workers.enhance_worker import SCANNER_INTENT_WHITELIST_CHARS

logger = logging.getLogger(__name__)

# Not pinned to JUDGE_MODEL. That pin exists because the judge rubric was
# calibrated against hand labels by scripts/holistic_judge.py and a different
# model invalidates the ~70% agreement figure. There is no calibration harness
# for this task, so there is nothing to invalidate — this uses the current
# default model rather than inheriting a pin whose reason does not apply.
OPTIMIZER_MODEL = "claude-opus-5"

# Generous. The output carries the rewritten prompt PLUS a line-by-line account
# of what was dropped and what was protected, and a truncated account is worse
# than useless — the operator would be approving a diff that isn't the diff.
OPTIMIZER_MAX_TOKENS = 8000

# Bounded well under the BFF's maxDuration so a slow call surfaces as a clean
# 504 from FastAPI rather than the edge function being killed mid-flight.
OPTIMIZER_TIMEOUT_S = 100.0


# Transcribed verbatim from enhance_worker._build_enhance_prompt. See
# DRIFT-WARNING in the module docstring.
GUARDRAILS_VERBATIM = """\
GUARDRAILS — hard constraints:
• Make, model, year, trim level. <equipment anatomy: same wheel count, fork
  count, fork length, mast stage count, counterweight shape, cab/overhead-guard
  structure>
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

## The one number that matters

The pipeline passes the operator's prompt into an automated review step that
whitelists "things the operator deliberately asked for", and it reads only the
first {SCANNER_INTENT_WHITELIST_CHARS} characters. Past that cut, the
operator's own requested edits get reported back as defects.

TARGET: {SCANNER_INTENT_WHITELIST_CHARS} characters or fewer. Going a little
over is better than dropping something from the PROTECTED list. Never pad to
reach the target — if a prompt is already short, return it nearly unchanged and
say so.

## ALWAYS CUT — the pipeline appends this itself, after the operator's text

This block is appended to EVERY enhancement, on top of whatever the operator
wrote. Any sentence in the operator's prompt that only restates part of it is
pure cost:

{GUARDRAILS_VERBATIM}

So cut: keeping the make/model/year/trim; preserving wheel count, fork count,
fork length, mast stages, counterweight or cab structure; "don't add lights /
beacons / mirrors / antennas / attachments / bolt-ons"; "don't add damage or
dents that weren't there"; "don't put it on a white / studio / gradient
background"; "don't zoom / crop / rotate / straighten / re-pose".

## ALSO CUT — these do nothing at all

- Curly-brace placeholders such as {{{{SOURCE_MODEL_TEXT}}}} or
  {{{{TARGET_MODEL_TEXT}}}}. There is no substitution engine. The literal
  braces reach the image model exactly as typed.
- Self-review instructions: "check your output", "verify each item", numbered
  QA checklists, "re-roll if wrong". An image model does not review its own
  output. These are among the largest sections in long prompts and they buy
  nothing.
- Meta-commentary addressed to a human: section headers that only organise the
  document, restatements of the same rule in three phrasings, and preambles
  about what the prompt is for.

## PROTECTED — never cut, never weaken. The pipeline does NOT add these.

When the operator supplies their own prompt, the built-in scene description is
skipped entirely. These six are only present if the operator's text carries
them. Losing one silently degrades every image made from this prompt:

1. DECAL / TEXT PRESERVATION — masking off OEM make, model, capacity and
   safety decals in their exact positions with their existing wear. This is the
   single most-often wrongly-cut item. It LOOKS covered by the guardrail about
   make and model. It is not: that guardrail governs the machine's identity,
   not the legibility of the printed decals.
2. TIRE TREATMENT — the tread-versus-sidewall distinction (shine the sidewalls,
   leave the tread dry and matte), and any non-marking / white / light-grey
   tyre carve-out.
3. SCENE AND COMPOSITION — same camera angle, perspective, framing, LIGHTING
   DIRECTION and BACKGROUND ENVIRONMENT. Note the guardrail covers crop, rotate
   and backdrop-swap only; lighting direction and background environment are
   not covered anywhere else.
4. THE HONESTY BOOKEND — that this is a cheap shop respray, explicitly not a
   restoration and not factory-fresh. This is what stops the result being a
   bait-and-switch listing photo.
5. WHAT THE PAINT DOES NOT COVER — dents, deep gouges, missing or broken parts,
   rust-through and pitting stay visible.
6. PAINT-JOB QUALITY — budget shop finish: slight orange-peel, minor overspray,
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
prompt is already at target, say so in `warnings` — an accurate warning is more
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

    # Advisory only — never enforced by truncation. Cutting the model's output
    # to fit would defeat the entire point: the operator would be shown, and
    # could save, a prompt whose tail had been silently amputated.
    if len(optimized) > SCANNER_INTENT_WHITELIST_CHARS:
        warnings.append(
            f"Still {len(optimized):,} characters — over the "
            f"{SCANNER_INTENT_WHITELIST_CHARS:,}-character review window by "
            f"{len(optimized) - SCANNER_INTENT_WHITELIST_CHARS:,}. Everything "
            f"past that point won't be recognised as deliberately requested."
        )

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
        "target_chars": SCANNER_INTENT_WHITELIST_CHARS,
        "removed": _as_pairs(result.get("removed")),
        "kept": _as_pairs(result.get("kept")),
        "warnings": warnings,
    }
