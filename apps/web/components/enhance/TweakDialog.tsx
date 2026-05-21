"use client";
// apps/web/components/enhance/TweakDialog.tsx
// Text-guided variant refinement modal — calls Gemini Flash Image with a
// short operator-supplied instruction and swaps the result in-place.
//
// Sister to EraseDialog. The functional split:
//   • Erase  → mask-based, surgical, BFL flux-tools/erase-v1.
//   • Tweak  → text-only, conversational, Gemini Flash Image.
// Use Erase when the area to change is visually obvious and a mask is
// easier than describing it. Use Tweak for additive changes ("add some
// surface scuffs to the side panel"), targeted subtractions where text
// is faster than painting ("remove the propane tank"), or property
// adjustments ("make the rust on the front bumper a little more visible").
//
// Polls the new job via useJobPoller (same 3s/10s/15s adaptive cadence
// the enhance + erase paths already use) and offers Accept / Try-again
// on the result before patching the variant in place.

import { useCallback, useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { enqueueTweak, getAssetUrl } from "../../lib/api";
import type { JobRecord } from "../../lib/types";
import { useJobPoller } from "../../lib/polling";

export interface TweakDialogResult {
  outputAssetId: string;
  outputUrl:     string;
}

interface TweakDialogProps {
  open: boolean;
  sessionId: string;
  /** Asset to tweak from — typically a completed variant's outputAssetId. */
  sourceAssetId: string;
  /** Signed GET URL for the source variant — displayed as the dialog's preview. */
  sourceImageUrl: string;
  onClose: () => void;
  onAccept: (result: TweakDialogResult) => void;
}

const MAX_INSTRUCTION_CHARS = 600;

const EXAMPLES = [
  "Remove the propane tank on the side.",
  "Add a small dent to the upper-left corner of the hood.",
  "Make the rust on the front bumper a bit more visible.",
  "Remove the orange traffic cone in the background.",
  "Erase the writing on the side panel.",
];

export function TweakDialog({
  open,
  sessionId,
  sourceAssetId,
  sourceImageUrl,
  onClose,
  onAccept,
}: TweakDialogProps) {
  const [instruction, setInstruction] = useState("");
  const [jobId,       setJobId]       = useState<string | null>(null);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [resultUrl,     setResultUrl]     = useState<string | null>(null);
  const [resultAssetId, setResultAssetId] = useState<string | null>(null);

  // Pick a placeholder example deterministically per source asset so the
  // same variant always shows the same suggestion (reduces visual jitter
  // when the dialog reopens on the same variant).
  const examplePlaceholder = useMemo(() => {
    if (!sourceAssetId) return EXAMPLES[0];
    let hash = 0;
    for (let i = 0; i < sourceAssetId.length; i++) {
      hash = (hash * 31 + sourceAssetId.charCodeAt(i)) | 0;
    }
    return EXAMPLES[Math.abs(hash) % EXAMPLES.length];
  }, [sourceAssetId]);

  // Reset state any time we reopen on a different source asset.
  useEffect(() => {
    if (!open) return;
    setInstruction("");
    setJobId(null);
    setJob(null);
    setSubmitting(false);
    setSubmitError(null);
    setResultUrl(null);
    setResultAssetId(null);
  }, [open, sourceAssetId]);

  // Esc closes (but not while submitting).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  const handleSubmit = useCallback(async () => {
    if (submitting || resultUrl) return;
    const trimmed = instruction.trim();
    if (trimmed.length < 3) {
      setSubmitError("Describe the change in at least a few words.");
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const { jobId: newJobId } = await enqueueTweak({
        sessionId,
        assetId:        sourceAssetId,
        instruction:    trimmed,
        idempotencyKey: `tweak-${sourceAssetId}-${uuidv4()}`,
      });
      setJobId(newJobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Tweak failed.");
      setSubmitting(false);
    }
  }, [submitting, resultUrl, instruction, sessionId, sourceAssetId]);

  useJobPoller(
    jobId,
    (j) => setJob(j),
    (j) => {
      setJob(j);
      if (!j.outputAssetId) {
        setSubmitError("Tweak completed but produced no asset.");
        setSubmitting(false);
        return;
      }
      getAssetUrl(j.outputAssetId)
        .then(({ url }) => {
          setResultAssetId(j.outputAssetId as string);
          setResultUrl(url);
          setSubmitting(false);
        })
        .catch((err: Error) => {
          setSubmitError(err.message);
          setSubmitting(false);
        });
    },
    (j) => {
      setJob(j);
      setSubmitError(j.error ?? "Tweak job failed.");
      setSubmitting(false);
    },
  );

  const handleAccept = () => {
    if (!resultUrl || !resultAssetId) return;
    onAccept({ outputAssetId: resultAssetId, outputUrl: resultUrl });
  };

  const handleDiscardResult = () => {
    setResultUrl(null);
    setResultAssetId(null);
    setJobId(null);
    setJob(null);
  };

  const progressLabel = useMemo(() => {
    if (!submitting) return null;
    if (!jobId) return "Submitting…";
    const s = job?.status;
    if (s === "queued")     return "Queued — waiting for Gemini…";
    if (s === "processing") return "Gemini editing…";
    if (s === "complete")   return "Finalising…";
    return "Working…";
  }, [submitting, jobId, job?.status]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tweak tool"
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-3xl max-h-full bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-900">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              Tweak — describe a targeted change
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Routed through Gemini Flash Image. Best for additive changes or text-easier-than-mask edits. Use Erase for surgical mask-based removal.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-xs uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {resultUrl ? "Close" : "Cancel"}
          </button>
        </header>

        {/* Preview + form */}
        <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
          <div className="relative mx-auto bg-zinc-900 rounded-lg overflow-hidden ring-1 ring-zinc-800 max-h-[50vh]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={resultUrl ?? sourceImageUrl}
              alt="Tweak preview"
              className="block max-w-full max-h-[50vh] object-contain select-none"
              draggable={false}
            />
            {submitting && !resultUrl && (
              <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-3">
                <svg className="animate-spin w-7 h-7 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                <span className="text-sm text-blue-300">{progressLabel}</span>
              </div>
            )}
          </div>

          {!resultUrl && (
            <label className="block">
              <span className="text-xs text-zinc-400 mb-1 block">
                Instruction
              </span>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value.slice(0, MAX_INSTRUCTION_CHARS))}
                disabled={submitting}
                placeholder={examplePlaceholder}
                rows={3}
                className="w-full bg-zinc-900 border border-zinc-800 focus:border-blue-600 focus:outline-none rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 disabled:opacity-40 resize-y min-h-[3.5rem]"
              />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-zinc-600 italic leading-snug">
                  Short imperative phrases work best. Gemini only touches what you name.
                </span>
                <span className="text-[10px] text-zinc-600 tabular-nums">
                  {instruction.length}/{MAX_INSTRUCTION_CHARS}
                </span>
              </div>
            </label>
          )}

          {submitError && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
              {submitError}
            </p>
          )}
        </div>

        {/* Footer actions */}
        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-900">
          {!resultUrl ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || instruction.trim().length < 3}
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors
                ${!submitting && instruction.trim().length >= 3
                  ? "bg-blue-600 hover:bg-blue-500 text-white"
                  : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}`}
            >
              {submitting ? "Working…" : "Apply tweak"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleDiscardResult}
                className="px-4 py-2 rounded-lg text-sm text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="px-5 py-2 rounded-lg text-sm font-semibold bg-green-600 hover:bg-green-500 text-white transition-colors"
              >
                Accept &amp; replace variant
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
