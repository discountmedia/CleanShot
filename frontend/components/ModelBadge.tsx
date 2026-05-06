"use client";

import type { EnhanceModelUsed } from "@/lib/types";
import { cx } from "@/lib/utils";

type Props = {
  model: EnhanceModelUsed | undefined;
};

/**
 * Pro Image vs Flash 2.5 fallback indicator.
 *
 * Per Phase 2 v2.4.1 § 1.5 — when gemini-3-pro-image-preview is unavailable
 * (NotFound / PermissionDenied), the worker falls back to
 * gemini-2.5-flash-image and tags the job with model_used='flash-2.5'.
 *
 * The badge needs to make the distinction visually obvious so a user
 * comparing two enhanced images side-by-side can tell which got the premium
 * treatment vs the cheaper backup.
 */
export function ModelBadge({ model }: Props) {
  if (!model) return null;
  const isPro = model === "pro";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-label",
        isPro
          ? "border-df-red/40 bg-df-red-tint text-df-red"
          : "border-line bg-surface-hover text-ink-muted",
      )}
      title={
        isPro
          ? "Generated with Gemini 3 Pro Image (preview)"
          : "Generated with Gemini 2.5 Flash Image (fallback — Pro Image was unavailable)"
      }
    >
      <span
        className={cx(
          "h-1.5 w-1.5 rounded-full",
          isPro ? "bg-df-red" : "bg-ink-dim",
        )}
        aria-hidden
      />
      {isPro ? "Pro Image" : "Flash 2.5 (fallback)"}
    </span>
  );
}
