"use client";
// apps/web/components/enhance/EraseDialog.tsx
// Mask-drawing modal for BFL flux-tools/erase-v1.
//
// Operator clicks "Erase" on a completed enhance variant → this dialog
// opens with that variant's image as the canvas background. They paint
// a binary mask over the area to remove (with brush size control + a
// Clear button), optionally type a short hint for what should fill the
// erased region, and submit. The mask is exported at the source image's
// natural pixel dimensions (white=erase, black=preserve) so BFL gets a
// faithful operator intent regardless of how the image was scaled on
// screen.
//
// Strokes are tracked in normalized [0,1] coords so they survive any
// display resize and can be redrawn into an offscreen canvas at the
// source's natural dimensions for export.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { v4 as uuidv4 } from "uuid";

import { enqueueErase, getAssetUrl } from "../../lib/api";
import type { JobRecord } from "../../lib/types";
import { useJobPoller } from "../../lib/polling";

/** A single brush stroke = polyline of normalized [0,1] points. */
type Stroke = {
  brush: number;        // brush diameter in normalized units (relative to displayed width)
  points: { x: number; y: number }[];
};

export interface EraseDialogResult {
  /** The new asset_id of the cleaned variant returned by BFL. */
  outputAssetId: string;
  /** Signed GET URL for the cleaned variant. */
  outputUrl:     string;
}

interface EraseDialogProps {
  /** Open/closed state. Parent owns this. */
  open: boolean;
  /** Session ID — forwarded to the BFF. */
  sessionId: string;
  /** Source asset to erase from. Typically a completed variant's outputAssetId. */
  sourceAssetId: string;
  /** Source variant's signed GET URL, displayed as the canvas background. */
  sourceImageUrl: string;
  /** Called when the operator dismisses without accepting a result. */
  onClose: () => void;
  /** Called when the operator accepts the erased result. */
  onAccept: (result: EraseDialogResult) => void;
}

const MIN_BRUSH_PX = 6;
const MAX_BRUSH_PX = 96;
const DEFAULT_BRUSH_PX = 28;
const MAX_INSTRUCTION_CHARS = 240;

export function EraseDialog({
  open,
  sessionId,
  sourceAssetId,
  sourceImageUrl,
  onClose,
  onAccept,
}: EraseDialogProps) {
  const imgRef    = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Drawing state.
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const [brushPx, setBrushPx] = useState(DEFAULT_BRUSH_PX);
  const [instruction, setInstruction] = useState("");

  // Source image natural dimensions — needed for export.
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  // Displayed image bounds inside the canvas wrapper.
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Submission lifecycle.
  const [jobId,       setJobId]       = useState<string | null>(null);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // While polling, holds the latest job record so we can show progress.
  const [job, setJob] = useState<JobRecord | null>(null);
  // Once the job completes and we've fetched the signed URL, show it
  // in the preview pane with Accept / Discard.
  const [resultUrl,     setResultUrl]     = useState<string | null>(null);
  const [resultAssetId, setResultAssetId] = useState<string | null>(null);

  // ── Wipe state any time we reopen on a different source ──────────────
  useEffect(() => {
    if (!open) return;
    setStrokes([]);
    setInstruction("");
    setJobId(null);
    setJob(null);
    setSubmitting(false);
    setSubmitError(null);
    setResultUrl(null);
    setResultAssetId(null);
    drawingRef.current = null;
  }, [open, sourceAssetId]);

  // ── Esc closes the dialog (only when not actively submitting) ────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  // ── Track displayed image size for canvas overlay sizing ──────────────
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = imgRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDisplaySize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (imgRef.current) ro.observe(imgRef.current);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [open, naturalSize]);

  // ── Redraw the overlay canvas whenever strokes change ────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale canvas backing store to display size × devicePixelRatio for
    // crisp lines on hi-dpi displays.
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.max(1, Math.round(displaySize.w * dpr));
    canvas.height = Math.max(1, Math.round(displaySize.h * dpr));
    canvas.style.width  = `${displaySize.w}px`;
    canvas.style.height = `${displaySize.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displaySize.w, displaySize.h);

    // Translucent white so the operator can still see what's under the mask.
    ctx.fillStyle   = "rgba(255, 64, 64, 0.45)";
    ctx.strokeStyle = "rgba(255, 64, 64, 0.45)";
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";

    const all: Stroke[] = drawingRef.current
      ? [...strokes, drawingRef.current]
      : strokes;

    for (const s of all) {
      const brushDisplayPx = s.brush * displaySize.w;
      ctx.lineWidth = brushDisplayPx;
      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.beginPath();
        ctx.arc(p.x * displaySize.w, p.y * displaySize.h, brushDisplayPx / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = p.x * displaySize.w;
        const y = p.y * displaySize.h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }, [strokes, displaySize.w, displaySize.h]);

  // ── Pointer handlers ─────────────────────────────────────────────────
  const pointerToNorm = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = canvasRef.current!;
      const r = c.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      };
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (resultUrl) return;        // Read-only once we have a result
      e.preventDefault();
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      const p = pointerToNorm(e);
      drawingRef.current = {
        brush:  brushPx / Math.max(1, displaySize.w),
        points: [p],
      };
      // Force a redraw so single-dot strokes appear immediately.
      setStrokes((prev) => prev.slice());
    },
    [brushPx, displaySize.w, pointerToNorm, resultUrl],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const p = pointerToNorm(e);
      drawingRef.current.points.push(p);
      setStrokes((prev) => prev.slice()); // trigger redraw via shallow update
    },
    [pointerToNorm],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // CAPTURE the stroke off the ref BEFORE clearing it. React's state
    // updater callback runs later (during the next state-processing pass);
    // if we cleared the ref first and read it inside the updater, we'd push
    // `null` into strokes — the redraw effect would then crash on `s.brush`.
    const stroke = drawingRef.current;
    if (!stroke) return;
    drawingRef.current = null;
    (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    setStrokes((prev) => [...prev, stroke]);
  }, []);

  // ── Mask export — offscreen canvas at natural source dimensions ──────
  const exportMaskPngBase64 = useCallback((): string | null => {
    if (!naturalSize) return null;
    if (strokes.length === 0) return null;

    const off = document.createElement("canvas");
    off.width  = naturalSize.w;
    off.height = naturalSize.h;
    const ctx  = off.getContext("2d");
    if (!ctx) return null;

    // Black canvas = preserve everywhere by default.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, off.width, off.height);

    // White strokes = erase. Use the same normalized coordinates and
    // brush-relative-to-width sizing as the display redraw, just
    // multiplied by natural width/height.
    ctx.fillStyle   = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";

    for (const s of strokes) {
      const brushNaturalPx = s.brush * naturalSize.w;
      ctx.lineWidth = brushNaturalPx;
      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.beginPath();
        ctx.arc(
          p.x * naturalSize.w,
          p.y * naturalSize.h,
          brushNaturalPx / 2,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = p.x * naturalSize.w;
        const y = p.y * naturalSize.h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const dataUrl = off.toDataURL("image/png");
    // Strip the "data:image/png;base64," prefix — BFL wants raw base64.
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  }, [naturalSize, strokes]);

  const handleClear = () => {
    if (resultUrl || submitting) return;
    setStrokes([]);
    drawingRef.current = null;
  };

  // ── Submit ──────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (submitting || resultUrl) return;
    const mask = exportMaskPngBase64();
    if (!mask) {
      setSubmitError("Paint over the area to erase before submitting.");
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const { jobId: newJobId } = await enqueueErase({
        sessionId,
        assetId:          sourceAssetId,
        maskPngBase64:    mask,
        instruction:      instruction.trim() || undefined,
        idempotencyKey:   `erase-${sourceAssetId}-${uuidv4()}`,
      });
      setJobId(newJobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Erase failed.");
      setSubmitting(false);
    }
  }, [
    submitting,
    resultUrl,
    exportMaskPngBase64,
    sessionId,
    sourceAssetId,
    instruction,
  ]);

  // ── Poll the erase job ──────────────────────────────────────────────
  useJobPoller(
    jobId,
    (j) => setJob(j),
    (j) => {
      // On complete, fetch the signed URL for the new asset.
      setJob(j);
      if (!j.outputAssetId) {
        setSubmitError("Erase completed but produced no asset.");
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
      setSubmitError(j.error ?? "Erase job failed.");
      setSubmitting(false);
    },
  );

  // ── Accept / Discard handlers ───────────────────────────────────────
  const handleAccept = () => {
    if (!resultUrl || !resultAssetId) return;
    onAccept({ outputAssetId: resultAssetId, outputUrl: resultUrl });
  };

  const handleDiscardResult = () => {
    // Drop the result, keep the strokes so they can refine + resubmit.
    setResultUrl(null);
    setResultAssetId(null);
    setJobId(null);
    setJob(null);
  };

  const progressLabel = useMemo(() => {
    if (!submitting) return null;
    if (!jobId) return "Submitting…";
    const s = job?.status;
    if (s === "queued")     return "Queued — waiting for a worker…";
    if (s === "processing") return "BFL working…";
    if (s === "complete")   return "Finalising…";
    return "Working…";
  }, [submitting, jobId, job?.status]);

  if (!open) return null;

  const hasStrokes = strokes.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Erase tool"
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        // Click outside the dialog closes it (unless submitting).
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-full max-w-5xl max-h-full bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* ── Header ── */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-zinc-900">
          <div>
            <h2 className="text-xl font-bold text-white">
              Erase — paint over what should be removed
            </h2>
            <p className="text-base text-zinc-200 mt-1 leading-relaxed">
              Routed through BFL flux-tools/erase-v1. Heavier strokes give the model more room to invent a clean fill.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-200 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5"
          >
            {resultUrl ? "Close" : "Cancel"}
          </button>
        </header>

        {/* ── Canvas + brush controls ── */}
        <div className="flex-1 overflow-auto p-5 flex flex-col gap-4">
          <div className="relative mx-auto bg-zinc-900 rounded-lg overflow-hidden ring-1 ring-zinc-800 max-h-[60vh]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={resultUrl ?? sourceImageUrl}
              alt="Erase canvas background"
              onLoad={(e) => {
                const el = e.currentTarget;
                setNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              className="block max-w-full max-h-[60vh] object-contain select-none"
              draggable={false}
            />
            {/* Drawing overlay — only active before we have a result */}
            {!resultUrl && (
              <canvas
                ref={canvasRef}
                className="absolute inset-0 cursor-crosshair touch-none"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            )}

            {/* Submitting overlay */}
            {submitting && !resultUrl && (
              <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-3">
                <svg className="animate-spin w-7 h-7 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                <span className="text-base font-bold text-blue-200">{progressLabel}</span>
              </div>
            )}
          </div>

          {/* Tip banner — how to use the brush. */}
          {!resultUrl && (
            <div className="rounded-lg border border-yellow-700/60 bg-yellow-950/30 px-4 py-3">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-yellow-200 mb-1">
                How to use the eraser
              </p>
              <p className="text-base text-yellow-100 leading-relaxed">
                Drag your cursor over anything you want gone — extra cones, propane tanks, people,
                logos, debris. Cover the whole object plus a little extra around the edges. The AI
                will invent a clean fill (sky, dirt, concrete, etc.) based on what surrounds it.
              </p>
            </div>
          )}

          {/* Brush + Clear */}
          {!resultUrl && (
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-3 text-base font-bold text-zinc-100">
                Brush
                <input
                  type="range"
                  min={MIN_BRUSH_PX}
                  max={MAX_BRUSH_PX}
                  value={brushPx}
                  disabled={submitting}
                  onChange={(e) => setBrushPx(Number(e.target.value))}
                  className="w-48 accent-blue-500 disabled:opacity-40"
                />
                <span className="font-mono text-zinc-200 tabular-nums w-12 text-right text-base">
                  {brushPx}px
                </span>
              </label>
              <button
                type="button"
                onClick={handleClear}
                disabled={!hasStrokes || submitting}
                className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-200 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors px-3 py-1.5 rounded border border-zinc-700 hover:border-zinc-400 disabled:hover:border-zinc-700"
              >
                Clear mask
              </button>
              <span className="text-sm font-bold text-zinc-200 ml-auto">
                {strokes.length} stroke{strokes.length === 1 ? "" : "s"}
              </span>
            </div>
          )}

          {/* Instruction */}
          {!resultUrl && (
            <label className="block">
              <span className="text-sm font-bold uppercase tracking-[0.16em] text-zinc-100 mb-1.5 block">
                Fill hint (optional)
              </span>
              <input
                type="text"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value.slice(0, MAX_INSTRUCTION_CHARS))}
                disabled={submitting}
                placeholder="e.g. plain concrete floor"
                className="w-full bg-zinc-900 border border-zinc-700 focus:border-blue-500 focus:outline-none rounded-lg px-3 py-2.5 text-base text-white placeholder:text-zinc-400 disabled:opacity-40"
              />
              <span className="text-sm text-zinc-300 mt-1 block text-right tabular-nums">
                {instruction.length}/{MAX_INSTRUCTION_CHARS}
              </span>
            </label>
          )}

          {/* Submit error */}
          {submitError && (
            <p className="text-base font-medium text-red-300 bg-red-950/40 border border-red-800 rounded px-3 py-2">
              {submitError}
            </p>
          )}
        </div>

        {/* ── Footer actions ── */}
        <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-900">
          {!resultUrl ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasStrokes || submitting || !naturalSize}
              className={`px-6 py-2.5 rounded-lg text-base font-bold transition-colors
                ${hasStrokes && !submitting && naturalSize
                  ? "bg-blue-600 hover:bg-blue-500 text-white"
                  : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}`}
            >
              {submitting ? "Working…" : "Erase masked area"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleDiscardResult}
                className="px-5 py-2.5 rounded-lg text-base font-bold text-zinc-100 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="px-6 py-2.5 rounded-lg text-base font-bold bg-green-600 hover:bg-green-500 text-white transition-colors"
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
