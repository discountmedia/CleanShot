"""
Per-model pricing → usage_events.cost_estimate_usd.

Two rate styles:
  • PER_IMAGE_USD — flat dollar amount per API call. Used for image-gen
    and image-edit models (Gemini Flash Image, OpenAI gpt-5, xAI Grok,
    Ideogram). These providers don't return token counts;
    they charge per generated image instead.
  • PER_TOKEN_USD — (input_per_million, output_per_million) tuples used
    for the text/vision LLMs (scan worker's gemini-2.5-flash, gpt-5.4,
    claude-opus-5). The worker needs to capture
    `usage_metadata` / `usage` from each provider's response and pass
    the counts here.

All rates verified against public docs on 2026-05-20. Update this file
when a provider publishes new pricing OR when you switch models — the
date in the trailing comment is the source-of-truth marker.

Where to verify:
  - Gemini:    https://ai.google.dev/gemini-api/docs/pricing
  - OpenAI:    https://platform.openai.com/docs/pricing
  - Anthropic: https://www.anthropic.com/pricing
  - xAI Grok:  https://docs.x.ai
"""

from __future__ import annotations


# ─── Per-image rates (image-gen / image-edit endpoints) ──────────────────────


PER_IMAGE_USD: dict[str, float] = {
    # Gemini Image (AI Studio paid tier). ⚠️ PRICE DEPENDS ON OUTPUT RESOLUTION,
    # so this row is COUPLED TO `GEMINI_IMAGE_SIZE` in enhance_worker.py —
    # change one and this must change with it. From Google's published pricing
    # for gemini-3.1-flash-image (image output billed at $60/1M tokens):
    #
    #   0.5K   747 tokens   $0.045
    #   1K    1120 tokens   $0.067      <- the old default
    #   2K    1680 tokens   $0.101      <- GEMINI_IMAGE_SIZE today
    #   4K    2520 tokens   $0.151
    #
    # The previous 0.039 was wrong twice over: it was the 2.5-flash-image rate
    # ($30/1M x 1290 tokens) carried across to a model billed at double that,
    # and it predates the 2K switch. So spend has been UNDER-reported since
    # 3.1 landed, not merely since today.
    "gemini-3.1-flash-image-preview": 0.101,
    # 2.5-flash-image genuinely is $0.039 (1290 tokens at $30/1M). Left alone —
    # the two models are not the same price and never were.
    "gemini-2.5-flash-image":         0.039,

    # OpenAI gpt-5 via Responses API with the image_generation tool
    # forced. Cost is gpt-5 tokens (input image + prompt + a short
    # reasoning step + tool-call output, typically ~1.2k input / ~200
    # output) plus the internal image_generation tool invocation
    # (gpt-image-* family at the tool's default quality tier).
    # Working placeholder of $0.08/edit — gpt-5 portion ~$0.01,
    # image-gen tool portion ~$0.07. Refine once real invoices land.
    "gpt-5":                          0.080,

    # fal.ai BiRefNet v2 background removal. fal bills per-megapixel on
    # most vision models; at 2048x2048 operating resolution this is a
    # sub-cent call. $0.002 is a PLACEHOLDER until a real invoice lands —
    # unlike the enhance rows this fires on every cutout, so it is worth
    # calibrating before reading any spend dashboard.
    "fal-ai/birefnet/v2":             0.002,
    # Photoroom background removal. AMORTISED, not metered: the plan is a flat
    # $20/month for 1000 images, so $0.02 is the blended cost of a fully-used
    # allowance rather than a price Photoroom charges per call. Two consequences
    # worth knowing before reading a total as an invoice line — under-using the
    # allowance makes the real per-image cost HIGHER than this, and going over
    # 1000 in a month is not modelled here at all. Revisit if volume approaches
    # the cap. Fires on every cutout, so it is the highest-frequency row here.
    "photoroom/segment":              0.02,
    # Florence-2 object detection for auto-crop. ⚠️ UNVERIFIED. fal's public
    # model page renders "$0 per compute second", which is far more likely to
    # be an unauthenticated page failing to fill in a rate than a genuinely
    # free GPU model — so treat this 0.0 as "not yet known", not as "free", and
    # check it against a real fal invoice. One call per enhance JOB, so a
    # 2-provider batch detects twice on the same source.
    "fal-ai/florence-2-large":        0.0,

    # xAI Grok image edit (https://docs.x.ai). Public pricing for
    # /v1/images/edits isn't published yet — placeholder of $0.07 per
    # edit (roughly the midpoint of comparable image-edit models).
    # Update once we have an invoice / real bill to calibrate against.
    "grok-imagine-image-quality":     0.070,

}


# ─── Per-token rates (text / vision LLMs) ────────────────────────────────────
#
# Tuple convention: (input_per_million_usd, output_per_million_usd).


PER_TOKEN_USD: dict[str, tuple[float, float]] = {
    # Vertex Gemini 2.5 Flash (used by scan_worker). Image tokens count
    # toward input at the same per-token rate; ~258 tokens per 512×512
    # tile so the cost per scan is dominated by output.
    "gemini-2.5-flash":  (0.075, 0.30),

    # OpenAI gpt-5.4 (Responses API; used by scan_worker for the OpenAI
    # provider branch).
    "gpt-5.4":           (5.00, 15.00),

    # Anthropic. Every Claude call in the app (scan, variant judge, prompt
    # optimizer) runs on opus-5 as of 2026-08-27. The older ids are retained
    # so that a re-run or a rolled-back model id still costs correctly.
    #
    # NOTE (corrected 2026-08-27): they are NOT needed to protect historical
    # data, which the previous wording claimed. cost_estimate_usd is computed
    # HERE and STORED on the usage_event row at insert time; the admin
    # dashboard SUMs that stored column and never re-derives it from the model
    # name. Removing a key cannot retroactively change an old row's cost --
    # verified when flux-erase-v1 / flux-1-kontext-max-edit /
    # reve-edit-fast-latest were dropped above on 2026-08-27.
    "claude-opus-5":     (5.00, 25.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-opus-4-7":   (15.00, 75.00),
}


def estimate_cost_usd(
    model: str,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
) -> float | None:
    """
    Compute the dollar cost of a single API call to `model`.

    Per-image models return their flat rate regardless of token args.
    Token-based models multiply the supplied counts by the per-million
    rates. Returns None when the model isn't in either table — callers
    pass that through to usage_events.cost_estimate_usd as NULL so the
    admin dashboard can show a dash rather than a fake zero.
    """
    if model in PER_IMAGE_USD:
        return PER_IMAGE_USD[model]

    if model in PER_TOKEN_USD:
        if input_tokens is None and output_tokens is None:
            return None
        rate_in, rate_out = PER_TOKEN_USD[model]
        cost = 0.0
        if input_tokens:
            cost += (input_tokens / 1_000_000.0) * rate_in
        if output_tokens:
            cost += (output_tokens / 1_000_000.0) * rate_out
        return round(cost, 6)

    return None
