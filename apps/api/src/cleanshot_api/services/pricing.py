"""
Per-model pricing → usage_events.cost_estimate_usd.

Two rate styles:
  • PER_IMAGE_USD — flat dollar amount per API call. Used for image-gen
    and image-edit models (Gemini Flash Image, OpenAI gpt-image-2,
    Black Forest Labs Flux). These providers don't return token counts;
    they charge per generated image instead.
  • PER_TOKEN_USD — (input_per_million, output_per_million) tuples used
    for the text/vision LLMs (scan worker's gemini-2.5-flash, gpt-5.4,
    claude-sonnet-4-6, claude-opus-4-7). The worker needs to capture
    `usage_metadata` / `usage` from each provider's response and pass
    the counts here.

All rates verified against public docs on 2026-05-20. Update this file
when a provider publishes new pricing OR when you switch models — the
date in the trailing comment is the source-of-truth marker.

Where to verify:
  - Gemini:    https://ai.google.dev/gemini-api/docs/pricing
  - OpenAI:    https://platform.openai.com/docs/pricing
  - Anthropic: https://www.anthropic.com/pricing
  - BFL Flux:  https://docs.bfl.ai/pricing
"""

from __future__ import annotations


# ─── Per-image rates (image-gen / image-edit endpoints) ──────────────────────


PER_IMAGE_USD: dict[str, float] = {
    # Gemini Image (AI Studio paid tier). The 3.1-flash-image-preview
    # is published at the same per-image rate as 2.5-flash-image; if
    # Google bumps preview rates we may need a separate entry.
    "gemini-3.1-flash-image-preview": 0.039,
    "gemini-2.5-flash-image":         0.039,

    # OpenAI gpt-image-2-2026-04-21. We always call with quality="high",
    # which is the upper rate tier (~$0.19/img at auto size). If we ever
    # switch to medium / low quality, drop to ~$0.07 / ~$0.04 here.
    "gpt-image-2-2026-04-21":         0.190,

    # Black Forest Labs FLUX 2 MAX. BFL bills credits; ~$0.06 in USD
    # equivalent at current credit rate (1024 credits ≈ $1, ~60 cr/call).
    "flux-2-max":                     0.060,
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

    # Anthropic — scan uses sonnet 4.6 by default and falls back to opus
    # 4.7 for "hard cases" via tool_choice forcing.
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
