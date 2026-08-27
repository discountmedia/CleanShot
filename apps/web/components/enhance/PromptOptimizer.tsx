"use client";

/**
 * Optimize prompt — condense a long template down to what the pipeline can
 * actually see, and show the operator exactly what changed before anything is
 * written anywhere.
 *
 * WHY IT EXISTS
 * -------------
 * Enhance passes the operator's prompt into the differential scanner's
 * "deliberately requested" whitelist, sliced at the first 1,500 characters
 * (SCANNER_INTENT_WHITELIST_CHARS on the API side). A 9,700-character template
 * is ~84% invisible to that whitelist, so edits the operator explicitly asked
 * for come back reported as defects. Meanwhile the safety guardrails are
 * appended to every prompt automatically, so a long prompt is usually spending
 * its budget restating text it gets for free.
 *
 * WHY IT NEVER WRITES ON ITS OWN
 * ------------------------------
 * Six blocks of the built-in prompt are NOT appended when the operator supplies
 * their own text (decal preservation is the one that looks redundant and is
 * not). If the optimizer drops one, every future image made from that template
 * quietly degrades — and the result still looks clean. So the diff is the
 * product here, not the button: `removed` and `kept` are rendered in full, and
 * nothing reaches the prompt box or the shared library without a second click.
 *
 * This is also why "Save as a new template" saves the SHORT text while leaving
 * the long prompt sitting in the box. Templates are immutable and permanent —
 * the short version is a new row under a new title, and the long one survives.
 */

import { useState } from "react";

import {
  optimizeSavedPrompt,
  type PromptOptimizeChange,
  type PromptOptimizeResult,
} from "../../lib/api";
import type { SavedPromptsState } from "./SavedPromptsBar";

/**
 * OPTIMIZE PINK — a documented exception to the house palette, added
 * 2026-08-27 at the operator's request. This is the fourth standing exception,
 * after SCAN_PROVIDER_COLOR, the Tweak button's #0A84FF and the template
 * picker's reuse of it.
 *
 * The palette rule it answers is "do not add a fourth accent" (STYLE_GUIDE.md).
 * The justification for breaking it: the three house accents are all spoken
 * for and none of them can carry this. Lime means "good / done", purple means
 * "primary action", red means "destructive". Optimize is none of those — it is
 * a rewrite the operator must then review — and it sits in a control row that
 * already has a lime button in it. A fourth hue is the point: it must not be
 * mistaken for Save.
 *
 * All three values are RED-dominant (R > B > G), so the "only blue-dominant
 * colours are the house purples" constraint is untouched.
 *
 * Applied as an inline `style`, not a Tailwind class, for the same reason
 * SCAN_PROVIDER_COLOR and PICKER_BLUE are: the pink family is deleted from the
 * theme (`--color-pink-*: initial` in globals.css), so there is no class to
 * write, and an inline value cannot be flattened to neutral by a restyle pass.
 *
 * TEXT ON THE FILL MUST BE THE NEAR-BLACK INK, not white. Measured: white on
 * #FF3EA5 is 3.24:1 and fails AA; #131313 on it is 5.74:1 and passes. Same
 * rule the lime `accent` fill and the picker blue already follow. The hover
 * value is darker and still ink-on-fill at 4.90:1.
 */
const OPTIMIZE_PINK      = "#FF3EA5";
const OPTIMIZE_PINK_DARK = "#F02E96";  // hover — 4.90:1 under #131313
const OPTIMIZE_PINK_INK  = "#131313";
/**
 * The same pink lightened for use AS TEXT on a dark surface. #FF3EA5 on
 * `bg-panel` is 4.26:1 and fails AA; this is 6.44:1 and passes. Fill and text
 * need different values — the same trap the CTA purples are flagged for.
 */
const OPTIMIZE_PINK_LABEL = "#FF8AC4";

interface PromptOptimizerProps {
  /** The prompt currently in the box — what gets optimized. */
  currentPrompt: string;
  /** Replaces the prompt box. Only ever called from an explicit click. */
  onApply: (body: string) => void;
  /** Shared template state, for handing the short version to the save flow. */
  savedPrompts: SavedPromptsState;
  equipmentType?: string;
}

/** One side of the diff. Kept deliberately plain — this is read, not admired. */
function ChangeList({
  title, hint, items, accent,
}: {
  title: string;
  hint: string;
  items: PromptOptimizeChange[];
  accent: "removed" | "kept";
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <h5 className="text-sm uppercase tracking-[0.14em] font-bold text-ink">
        {title}{" "}
        <span className="tabular-nums text-ink-faint">({items.length})</span>
      </h5>
      <p className="text-sm text-ink-soft leading-relaxed">{hint}</p>
      <ul className="space-y-2">
        {items.map((c, i) => (
          <li
            key={i}
            className={`rounded-md bg-well px-3 py-2 border-l-2 ${
              accent === "kept" ? "border-accent" : "border-line"
            }`}
          >
            <p className="text-sm text-ink leading-relaxed">{c.text}</p>
            {c.reason && (
              <p className="text-sm text-ink-soft leading-relaxed mt-1">
                {c.reason}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PromptOptimizer({
  currentPrompt, onApply, savedPrompts, equipmentType,
}: PromptOptimizerProps) {
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [result, setResult] = useState<PromptOptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chars = currentPrompt.length;
  const hasPrompt = currentPrompt.trim().length > 0;

  // The threshold the button's own copy is about. Matches the API's
  // SCANNER_INTENT_WHITELIST_CHARS; the response echoes the authoritative
  // value back as `targetChars`, which is what the result panel shows.
  const TARGET = 1500;
  const isLong = chars > TARGET;

  const runOptimize = async () => {
    setIsOptimizing(true);
    setError(null);
    try {
      const res = await optimizeSavedPrompt({
        body: currentPrompt,
        equipmentType,
      });
      setResult(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Optimize failed");
    } finally {
      setIsOptimizing(false);
    }
  };

  const saveAsNew = () => {
    if (!result) return;
    // Hands the SHORT text to the existing naming panel. The long prompt stays
    // in the box untouched — templates are immutable, so this becomes a new
    // row under a new title rather than an edit of anything.
    savedPrompts.setSavedNotice(null);
    savedPrompts.setPendingSaveBody(result.optimizedPrompt);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void runOptimize()}
          disabled={!hasPrompt || isOptimizing}
          title={
            hasPrompt
              ? "Rewrite this prompt shorter, keeping everything the pipeline doesn't add for you. Shows you what it cut before anything changes."
              : "Write a prompt first — there's nothing to optimize yet"
          }
          style={
            hasPrompt && !isOptimizing
              ? { backgroundColor: OPTIMIZE_PINK, color: OPTIMIZE_PINK_INK }
              : undefined
          }
          onMouseEnter={(e) => {
            if (hasPrompt && !isOptimizing) {
              e.currentTarget.style.backgroundColor = OPTIMIZE_PINK_DARK;
            }
          }}
          onMouseLeave={(e) => {
            if (hasPrompt && !isOptimizing) {
              e.currentTarget.style.backgroundColor = OPTIMIZE_PINK;
            }
          }}
          // The enabled branch sets its fill and text via `style` (the pink is
          // not in the theme), so it only needs the transparent border here.
          // Both branches must name the border explicitly — listing
          // `border-transparent` on the base and `border-line` in the branch
          // leaves two competing utilities whose winner depends on generated
          // stylesheet order, not on the order written here.
          className={`text-sm uppercase tracking-[0.14em] font-bold px-4 py-2.5 rounded-lg border-2 transition-colors ${
            hasPrompt && !isOptimizing
              ? "border-transparent"
              : "border-line bg-panel text-muted cursor-not-allowed"
          }`}
        >
          {isOptimizing ? "Optimizing…" : "Optimize prompt"}
        </button>

        {hasPrompt && (
          <p className="text-sm text-ink-soft leading-relaxed">
            <span className="tabular-nums font-semibold text-ink">
              {chars.toLocaleString()}
            </span>{" "}
            characters.{" "}
            {isLong ? (
              <>
                Only the first{" "}
                <span className="tabular-nums">{TARGET.toLocaleString()}</span>{" "}
                are read when deciding which edits you asked for on purpose —
                the rest can come back flagged as faults.
              </>
            ) : (
              <>Comfortably inside the review window. Nothing needs cutting.</>
            )}
          </p>
        )}
      </div>

      {error && (
        <p className="text-base font-semibold text-danger-ink leading-relaxed">
          {error}
        </p>
      )}

      {result && (
        <div
          className="rounded-lg border-2 bg-panel px-4 py-3 space-y-4"
          style={{ borderColor: OPTIMIZE_PINK }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4
              className="text-base uppercase tracking-[0.14em] font-bold"
              style={{ color: OPTIMIZE_PINK_LABEL }}
            >
              Optimized — review before you use it
            </h4>
            <p className="text-sm text-ink-soft tabular-nums">
              {result.originalChars.toLocaleString()} →{" "}
              <span className="font-bold text-ink">
                {result.optimizedChars.toLocaleString()}
              </span>{" "}
              characters (target {result.targetChars.toLocaleString()})
            </p>
          </div>

          {result.warnings.length > 0 && (
            <ul className="space-y-1">
              {result.warnings.map((w, i) => (
                <li
                  key={i}
                  className="text-sm text-ink leading-relaxed border-l-2 border-attn pl-3"
                >
                  {w}
                </li>
              ))}
            </ul>
          )}

          <textarea
            readOnly
            value={result.optimizedPrompt}
            rows={10}
            aria-label="Optimized prompt"
            className="w-full bg-well border border-line rounded-md px-3 py-2.5 text-base text-ink focus:outline-none focus:ring-2 focus:ring-cta leading-relaxed"
          />

          <ChangeList
            title="Kept"
            hint="The pipeline does NOT add these for you when you write your own prompt — they only work because they're in your text. Check they all survived."
            items={result.kept}
            accent="kept"
          />
          <ChangeList
            title="Removed"
            hint="Cut because the pipeline already appends it, or because it does nothing."
            items={result.removed}
            accent="removed"
          />

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={saveAsNew}
              style={{ backgroundColor: OPTIMIZE_PINK, color: OPTIMIZE_PINK_INK }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = OPTIMIZE_PINK_DARK;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = OPTIMIZE_PINK;
              }}
              className="text-sm uppercase tracking-[0.14em] font-bold px-4 py-2.5 rounded-lg border-2 border-transparent transition-colors"
            >
              Save as a new template
            </button>
            <button
              type="button"
              onClick={() => {
                onApply(result.optimizedPrompt);
                setResult(null);
              }}
              title="Puts the short version in the prompt box, replacing what's there now."
              className="text-sm uppercase tracking-[0.14em] font-bold px-4 py-2.5 rounded-lg border-2 border-line bg-panel-hi hover:bg-line text-ink transition-colors"
            >
              Use it in the box
            </button>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="text-sm font-bold text-ink-soft hover:text-ink transition-colors"
            >
              Discard
            </button>
          </div>

          <p className="text-sm text-ink-soft leading-relaxed">
            <strong className="text-ink">Save as a new template</strong> keeps
            the long prompt in the box and files the short one under its own
            title — titles are permanent, so this is a new template, not an edit
            of the original.
          </p>
        </div>
      )}
    </div>
  );
}
