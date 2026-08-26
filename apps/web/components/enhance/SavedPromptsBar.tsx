"use client";
// apps/web/components/enhance/SavedPromptsBar.tsx
//
// Save / insert / rate / curate the SHARED prompt templates.
//
// SHARED SINCE 2026-08-25. These used to be private per-user prompts saved
// "to your profile". They are now one company-wide library: a template one
// operator writes for a sitdown Hyster is picked straight out of the list by
// everyone else.
//
// FOUR RULES THAT LOOK LIKE MISSING FEATURES AND ARE NOT:
//
//  • A template CANNOT BE RENAMED OR EDITED. It is written once. Votes and a
//    use count accumulate against a specific text, and editing the row under
//    them would leave that reputation pointing at something nobody endorsed —
//    the top-rated template would be top-rated for a prompt that no longer
//    exists. Customising is load → edit → save under a new title.
//
//  • DELETE IS ADMIN ONLY, not creator-or-admin. Once other people rely on a
//    template, its author is not the person with the most at stake in
//    removing it.
//
//  • ONE VOTE PER USER, enforced by a composite primary key in Postgres, not
//    by anything in this file. The count is a headcount, not a tally.
//
//  • The picker is a CUSTOM LISTBOX, not a <select>. A native <option>
//    renders plain text only — no byline, no vote button, no second line —
//    and all three are the point of a shared library. Collapsing this back to
//    a <select> silently deletes the attribution and the rating controls.
//
// SPLIT ACROSS TWO ROWS (2026-08-21 layout pass). The template picker sits up
// beside "Insert recommended prompt" so the two read as a pair, and the save +
// curate controls sit below the textarea, right-aligned. Because those are two
// different rows in EnhancePanel's tree, the shared state lives in
// `useSavedPrompts()` — EnhancePanel calls it once and hands the same state to
// both pieces. Two independent components would each fetch their own list, and
// saving or voting in one would not update the other.
//
// One more deliberate choice: the title is collected in an INLINE field, not
// window.prompt(). A native prompt is unstyled, ignores the house palette
// entirely, and is blocked outright in some browsers — a save that silently
// does nothing is worse than one that takes an extra click.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { TipBanner } from "../workspace/TipBanner";
import {
  PromptTitleConflictError,
  deleteSavedPrompt,
  listSavedPrompts,
  recordSavedPromptUse,
  saveSavedPrompt,
  sortSavedPrompts,
  voteSavedPrompt,
  type SavedPrompt,
  type TemplateSort,
} from "../../lib/api";

/**
 * TEMPLATE-PICKER BLUE — a documented exception to the house palette, added
 * 2026-08-26 at the operator's request because the picker was disappearing
 * into the panel and templates are now the main way a prompt gets written.
 *
 * The palette rule is that the only blue-dominant colours allowed are the
 * three house purples (see styles/globals.css). This is the third standing
 * exception, after SCAN_PROVIDER_COLOR and the Tweak button's #0A84FF — and it
 * reuses that same #0A84FF rather than inventing a fourth blue.
 *
 * Applied as an inline `style`, not a Tailwind class, for the same reason
 * SCAN_PROVIDER_COLOR is: the offending colour families are deleted from the
 * theme, so there is no class to write, and an inline value cannot be flattened
 * to neutral grey by a later restyle pass.
 *
 * TEXT ON IT MUST BE THE NEAR-BLACK INK, not white. Measured: white on
 * #0A84FF is 3.65:1, which fails AA for body-size text; #131313 on it is
 * 5.09:1, which passes. Same rule the lime `accent` fill already follows.
 */
const PICKER_BLUE      = "#0A84FF";
const PICKER_BLUE_DARK = "#0069D9";  // hover only — 4.4:1 vs white, still ink-on-fill
const PICKER_INK       = "#131313";
/**
 * The same blue lightened for use AS TEXT on a dark surface. #0A84FF on
 * `bg-panel` is 3.83:1 and fails AA; this is 6.0:1 and passes. Fill and text
 * need different values — that is the same trap the palette notes flag for the
 * CTA purples, which are fill-only.
 */
const PICKER_BLUE_LABEL = "#5AB0FF";

/** The three orderings, with the tooltip copy that explains each one. */
const SORTS: { key: TemplateSort; label: string; hint: string }[] = [
  {
    key: "recent",
    label: "Newest",
    hint: "Most recently added first. Using or upvoting a template never changes this order.",
  },
  {
    key: "top",
    label: "Top rated",
    hint: "Most upvotes first. One vote per person, so this is how many people endorse it — not how often it's been clicked.",
  },
  {
    key: "used",
    label: "Most used",
    hint: "Loaded into the prompt box most often. Popular isn't the same as endorsed — a template can be used a lot and rated by nobody.",
  },
];

/**
 * Short, unambiguous date for a byline: "Aug 25", or "Aug 25, 2025" once the
 * year stops being obvious. A template's age is a real signal in a shared
 * list — an old one may predate the current prompt guidance — so the year
 * has to appear when it matters, without adding noise when it doesn't.
 */
function formatByDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The template state, owned in ONE place and shared by both halves of the
 * split UI. EnhancePanel calls this once.
 */
export function useSavedPrompts() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [sort, setSort] = useState<TemplateSort>("top");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const rows = await listSavedPrompts(signal);
      setPrompts(rows);
      setError(null);
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Couldn't load shared templates");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // Fetch-on-mount: every setState inside `refresh` happens after an await,
    // i.e. in a later tick, and the AbortController cancels an in-flight read
    // on unmount. The lint rule can't see past the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set from an awaited fetch, not synchronously in the effect body.
    void refresh(ac.signal);
    return () => ac.abort();
  }, [refresh]);

  /**
   * Toggle this user's upvote. Optimistic, then corrected: the local ±1 is
   * shown immediately because a vote that lags feels broken, but the server's
   * count is what the row settles on — two people voting in the same second
   * means the local guess is often not the whole story. A failure rolls the
   * row back rather than leaving a vote that isn't really there.
   */
  const toggleVote = useCallback(async (target: SavedPrompt) => {
    const next = !target.votedByMe;
    setPrompts((rows) => rows.map((r) => (
      r.id === target.id
        ? { ...r, votedByMe: next, voteCount: r.voteCount + (next ? 1 : -1) }
        : r
    )));
    try {
      const truth = await voteSavedPrompt(target.id, next);
      setPrompts((rows) => rows.map((r) => (
        r.id === target.id
          ? { ...r, votedByMe: truth.voted, voteCount: truth.voteCount }
          : r
      )));
    } catch (err: unknown) {
      setPrompts((rows) => rows.map((r) => (
        r.id === target.id
          ? { ...r, votedByMe: target.votedByMe, voteCount: target.voteCount }
          : r
      )));
      setError(err instanceof Error ? err.message : "Couldn't record that vote");
    }
  }, []);

  /**
   * Count one use. Fire-and-forget by design — the template is already in the
   * operator's prompt box, so a failed counter must not turn into an error
   * message about something that plainly worked. The local bump is what the
   * operator sees; the server reconciles on the next load.
   */
  const noteUse = useCallback((id: string) => {
    setPrompts((rows) => rows.map((r) => (
      r.id === id ? { ...r, useCount: r.useCount + 1 } : r
    )));
    void recordSavedPromptUse(id);
  }, []);

  return {
    prompts, loading, error, setError,
    savedNotice, setSavedNotice, refresh,
    sort, setSort, toggleVote, noteUse,
  };
}

export type SavedPromptsState = ReturnType<typeof useSavedPrompts>;

/**
 * The ▲ upvote control. Its own component because it renders in two places,
 * and because it must never be nested inside the row's main button — a button
 * inside a button is invalid HTML and the inner click doesn't reliably fire.
 */
function VoteButton({
  prompt, onToggle, compact = false,
}: {
  prompt: SavedPrompt;
  onToggle: (p: SavedPrompt) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // The row behind this is "insert this template". Voting is not that.
        e.stopPropagation();
        onToggle(prompt);
      }}
      aria-pressed={prompt.votedByMe}
      aria-label={
        prompt.votedByMe
          ? `Remove your upvote from ${prompt.title}`
          : `Upvote ${prompt.title}`
      }
      title={
        prompt.votedByMe
          ? `You upvoted this. ${prompt.voteCount} ${prompt.voteCount === 1 ? "person rates" : "people rate"} it. Click to take your vote back.`
          : `Upvote this template so it rises in "Top rated". One vote per person — ${prompt.voteCount} so far.`
      }
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 ${compact ? "py-1" : "py-1.5"} text-sm font-bold transition-colors ${
        prompt.votedByMe
          ? "border-accent bg-accent text-header-bg"
          : "border-line bg-panel text-ink-soft hover:text-ink hover:border-ink-soft"
      }`}
    >
      <span aria-hidden="true">▲</span>
      <span>{prompt.voteCount}</span>
    </button>
  );
}

interface SavedPromptSelectProps {
  state: SavedPromptsState;
  /** Current contents of the prompt field — drives the replace confirm. */
  currentPrompt: string;
  /** Insert a template's text into the field, replacing what's there. */
  onInsert: (body: string) => void;
}

/**
 * The template picker. Rendered beside "Insert recommended prompt" so the two
 * ways of filling the prompt box sit together.
 *
 * A custom listbox rather than a <select>, because each row carries a byline,
 * a vote button and a use count. The cost is that the keyboard and dismiss
 * behaviour a <select> gives free has to be written: Escape closes, arrows
 * move, Enter picks, a click outside closes, and focus returns to the trigger
 * so tab order survives.
 */
export function SavedPromptSelect({
  state, currentPrompt, onInsert,
}: SavedPromptSelectProps) {
  const listboxId = useId();
  const { prompts, loading, setSavedNotice, sort, setSort, toggleVote, noteUse } = state;
  const hasPrompt = currentPrompt.trim().length > 0;

  // The sort is applied here, not on the server: the library is small, the
  // whole list is already in hand, and re-sorting locally means switching
  // between Newest / Top rated / Most used is instant instead of a fetch.
  const ordered = useMemo(() => sortSavedPrompts(prompts, sort), [prompts, sort]);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef    = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Close on click-outside / Escape. Both listeners live on the document
  // because the click that dismisses is by definition not on this subtree.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move real DOM focus with the highlight. `autoFocus` would only fire on
  // mount, which leaves the focus ring stuck on the first row while the arrow
  // keys move the highlight somewhere else — and worse, the <ul> only receives
  // keydown at all while focus is inside it, so this is what keeps the arrows
  // working past the first press.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const handleInsert = (p: SavedPrompt) => {
    setOpen(false);
    triggerRef.current?.focus();
    // Inserting replaces the box. If there's text in there that isn't already
    // this template, the operator is about to lose it, so ask first.
    if (hasPrompt && currentPrompt.trim() !== p.body.trim()) {
      const ok = window.confirm(
        `Replace the prompt currently in the box with "${p.title}"?\n\n` +
        `Anything you've typed and not saved will be lost.`,
      );
      if (!ok) return;
    }
    // A copy of the text, not a live link — editing the box never writes back
    // to the shared template, so trying someone else's out and then reworking
    // it can't damage theirs. That is also the supported way to customise:
    // load, edit, save under a new title.
    onInsert(p.body);
    noteUse(p.id);
    setSavedNotice(
      `Loaded "${p.title}" — edits here won't change the shared template. ` +
      `To keep your version, save it under a new title.`,
    );
  };

  const disabled = loading || ordered.length === 0;
  const label = loading
    ? "Loading…"
    : ordered.length === 0
      ? "No shared templates yet"
      : "Use a shared template…";

  return (
    /* max-w-full + min-w-0: the trigger must be allowed to shrink below its
       widest template title, or a long one pushes this row wider than the
       phone viewport. */
    <div ref={rootRef} className="relative max-w-full min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={
          disabled
            ? "Nobody has saved a shared template yet. Write a prompt and save it to start the library."
            : "Browse prompt templates saved by everyone on the team. Picking one replaces the prompt box with a copy you can edit freely."
        }
        onClick={() => {
          setActiveIndex(0);
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActiveIndex(0);
            setOpen(true);
          }
        }}
        /* py-3 matches the recommended-prompt button's height so the pair sits
           on one baseline. Bright blue fill (see PICKER_BLUE above) so the
           picker reads as the primary way into the prompt box rather than an
           inert form control. Disabled — an empty library — drops back to the
           neutral panel treatment, because there is nothing to draw the eye
           to yet and a bright button that does nothing is worse than a quiet
           one. */
        style={
          disabled
            ? undefined
            : { backgroundColor: PICKER_BLUE, borderColor: PICKER_BLUE, color: PICKER_INK }
        }
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.backgroundColor = PICKER_BLUE_DARK;
        }}
        onMouseLeave={(e) => {
          if (!disabled) e.currentTarget.style.backgroundColor = PICKER_BLUE;
        }}
        className={`w-full flex items-center justify-between gap-2 border-2 rounded-lg px-3 py-3 text-base font-bold text-left focus:outline-none focus:ring-2 focus:ring-cta ${
          disabled
            ? "bg-panel border-line text-ink opacity-60"
            : "transition-colors"
        }`}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden="true" className="shrink-0">▾</span>
      </button>

      {open && ordered.length > 0 && (
        /* z-20 clears the prompt textarea below it; max-h + overflow keeps a
           long library from running off the bottom of the panel. w-80 with
           min-w-full lets the popover be WIDER than a narrow trigger — the
           rows carry a byline and two counters and get unreadable if they
           inherit a squeezed column. */
        <div className="absolute z-20 mt-1 w-80 min-w-full max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel shadow-lg">
          {/* Sort strip. Three orderings of the same fetched list, each with a
              tooltip saying what it actually measures — "top rated" and "most
              used" sound interchangeable and are not. */}
          <div className="flex items-center gap-1 border-b border-line px-2 py-2">
            <span className="px-1 text-sm text-ink-soft font-semibold">Sort</span>
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSort(s.key)}
                title={s.hint}
                aria-pressed={sort === s.key}
                style={
                  sort === s.key
                    ? { borderColor: PICKER_BLUE, color: PICKER_BLUE_LABEL }
                    : undefined
                }
                className={`rounded-md px-2 py-1 text-sm font-bold transition-colors ${
                  sort === s.key
                    ? "bg-panel-hi border"
                    : "border border-transparent text-ink-soft hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <ul
            id={listboxId}
            role="listbox"
            aria-label="Shared prompt templates"
            tabIndex={-1}
            className="max-h-72 overflow-y-auto divide-y divide-line"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, ordered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const chosen = ordered[activeIndex];
                if (chosen) handleInsert(chosen);
              }
            }}
          >
            {ordered.map((p, i) => (
              <li key={p.id} className="flex items-center gap-2 pr-2">
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => handleInsert(p)}
                  title={`Load "${p.title}" into the prompt box. You get an editable copy — the shared template never changes.`}
                  className={`flex-1 min-w-0 text-left px-3 py-2.5 transition-colors focus:outline-none ${
                    i === activeIndex ? "bg-panel-hi" : "hover:bg-panel-hi"
                  }`}
                >
                  <span className="block text-base font-semibold text-ink truncate">
                    {p.title}
                  </span>
                  {/* The byline plus the use count. Smaller and muted so they
                      read as metadata rather than part of the name, but
                      full-contrast enough to actually be read — ink-soft, not
                      ink-faint. */}
                  <span className="block text-sm text-ink-soft truncate">
                    {p.authorName} · {formatByDate(p.createdAt)}
                    {p.useCount > 0 && ` · used ${p.useCount}×`}
                  </span>
                </button>
                <VoteButton prompt={p} onToggle={toggleVote} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface SavedPromptsBarProps {
  state: SavedPromptsState;
  /** Current contents of the prompt field. What Save writes. */
  currentPrompt: string;
}

export function SavedPromptsBar({ state, currentPrompt }: SavedPromptsBarProps) {
  const titleFieldId = useId();

  const {
    prompts, error, setError, savedNotice, setSavedNotice, refresh, sort, toggleVote,
  } = state;

  // Save flow: idle → naming (inline title field) → conflict (title is taken)
  const [saveState, setSaveState] = useState<"idle" | "naming" | "conflict">("idle");
  const [titleDraft, setTitleDraft] = useState("");
  const [isSaving,   setIsSaving]   = useState(false);
  // Whose title the collision is with — wording only. Either way the answer
  // is a different title; titles are permanent and there is no overwrite.
  const [conflictMine, setConflictMine] = useState(true);

  const [manageOpen, setManageOpen] = useState(false);

  const hasPrompt = currentPrompt.trim().length > 0;
  // Delete is admin-only, so Curate is an admin panel. `canDelete` is the same
  // for every row; reading it off the list avoids threading a separate "am I
  // an admin" prop all the way down here.
  const isAdmin = prompts.some((p) => p.canDelete);
  const ordered = useMemo(() => sortSavedPrompts(prompts, sort), [prompts, sort]);

  // ─── Save ────────────────────────────────────────────────────────────────

  const commitSave = async () => {
    const title = titleDraft.trim();
    if (!title || !hasPrompt) return;
    setIsSaving(true);
    setError(null);
    try {
      await saveSavedPrompt({ title, body: currentPrompt });
      setSaveState("idle");
      setTitleDraft("");
      setSavedNotice(`Saved "${title}" to shared templates — everyone can use it now`);
      await refresh();
    } catch (err: unknown) {
      if (err instanceof PromptTitleConflictError) {
        // Not an error state — it's a question. Ask it.
        setConflictMine(err.mine);
        setSaveState("conflict");
      } else {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Curate (admin) ──────────────────────────────────────────────────────

  const handleDelete = async (p: SavedPrompt) => {
    const ok = window.confirm(
      `Delete the shared template "${p.title}"?\n\n` +
      `It has ${p.voteCount} upvote${p.voteCount === 1 ? "" : "s"} and has been used ` +
      `${p.useCount} time${p.useCount === 1 ? "" : "s"}. It will disappear for everyone, ` +
      `along with its votes, and this can't be undone.`,
    );
    if (!ok) return;
    try {
      await deleteSavedPrompt(p.id);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="mt-3 space-y-3">
      {/* Curate on the left, Save on the right. `justify-end` + `mr-auto` on
          the left control keeps Save hard against the right edge without
          leaving a hole where the picker used to sit — that moved up beside
          "Insert recommended prompt". On a narrow screen `flex-wrap` drops
          Save onto its own line rather than squeezing the pair. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {isAdmin && prompts.length > 0 && (
          <button
            type="button"
            onClick={() => setManageOpen((v) => !v)}
            title="Admin only: remove templates from the shared library. Nobody else can delete, including the person who wrote it."
            className="mr-auto text-sm font-bold text-ink-soft hover:text-ink transition-colors"
          >
            {manageOpen ? "Done curating" : "Curate library (admin)"}
          </button>
        )}

        {/* ── Save ──
            Lime (`accent`) is the app's existing green — the same token the
            Download ZIP button uses. `text-header-bg` is mandatory on a lime
            fill; white is ~1.5:1 (see the palette notes in globals.css). */}
        <button
          type="button"
          onClick={() => {
            setSaveState("naming");
            setSavedNotice(null);
          }}
          disabled={!hasPrompt || saveState !== "idle"}
          title={
            hasPrompt
              ? "Save the prompt currently in the box as a template everyone can use. It gets a permanent title — to change a template later, load it, edit it, and save it again under a new title."
              : "Write a prompt first — there's nothing to save yet"
          }
          className={`text-sm uppercase tracking-[0.14em] font-bold px-4 py-2.5 rounded-lg border-2 transition-colors ${
            hasPrompt && saveState === "idle"
              ? "border-accent bg-accent hover:bg-accent/85 text-header-bg"
              : "border-line bg-panel text-ink-faint cursor-not-allowed"
          }`}
        >
          Save prompt to shared templates
        </button>
      </div>

      {/* The explainer. These rules are not guessable from the controls —
          especially that titles are permanent, and that "top rated" and "most
          used" measure different things — so they get said once, in prose,
          in a banner that collapses itself for operators who already know. */}
      <TipBanner title="How shared templates work" steps={[
        <>
          <strong>Everyone shares one library.</strong> Anything you save is
          immediately visible to every other user, credited to you with the date
          you saved it. There are no private prompts.
        </>,
        <>
          <strong>Titles are permanent.</strong> A template can&apos;t be renamed
          or edited after it&apos;s saved — not even by the person who wrote it.
          To make your own version: load a template, change the text in the box,
          then save it under a new title. The original is untouched.
        </>,
        <>
          <strong>Loading a template gives you a copy.</strong> Editing the
          prompt box never writes back to the shared template, so you can freely
          try someone else&apos;s and rework it.
        </>,
        <>
          <strong>▲ upvote what works.</strong> One vote per person, and you can
          take it back by clicking again. <em>Top rated</em> sorts by how many
          people endorse a template; <em>Most used</em> sorts by how often
          it&apos;s been loaded. They are not the same signal — something can be
          used constantly and rated by nobody.
        </>,
        <>
          <strong>Only an admin can delete.</strong> Removing a template removes
          it for everybody, so it isn&apos;t something an author does to their
          own entry. Ask an admin if something needs to go.
        </>,
      ]}>
        A prompt that produces a good result is worth keeping, and worth handing
        to the next person. Save it here and it becomes part of the team&apos;s
        library.
      </TipBanner>

      {/* ── Inline title field ── */}
      {saveState === "naming" && (
        <div className="rounded-lg border-2 border-cta bg-panel px-4 py-3 space-y-2">
          <label
            htmlFor={titleFieldId}
            className="block text-sm uppercase tracking-[0.14em] font-bold text-ink"
          >
            Title this template
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={titleFieldId}
              type="text"
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && titleDraft.trim()) {
                  e.preventDefault();
                  void commitSave();
                }
                if (e.key === "Escape") setSaveState("idle");
              }}
              placeholder="e.g. Sitdown Hyster, heavy rust"
              maxLength={120}
              title="Pick carefully — this title is permanent and shared with everyone. Describe the machine and the situation; your name and the date are added automatically."
              className="flex-1 min-w-56 bg-well border border-line rounded-md px-3 py-2 text-base text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-cta"
            />
            <button
              type="button"
              onClick={() => void commitSave()}
              disabled={!titleDraft.trim() || isSaving}
              className={`text-sm uppercase tracking-[0.14em] font-bold px-4 py-2 rounded-lg border-2 transition-colors ${
                titleDraft.trim() && !isSaving
                  ? "border-cta bg-cta hover:bg-cta-dark text-white"
                  : "border-line bg-panel text-ink-faint cursor-not-allowed"
              }`}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSaveState("idle");
                setTitleDraft("");
              }}
              className="text-sm font-bold text-ink-soft hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>
          <p className="text-sm text-ink-soft leading-relaxed">
            A title is required, it&apos;s how everyone will find this template,
            and <strong className="text-ink">it can&apos;t be changed later</strong>.
            Your name and today&apos;s date are shown beside it automatically.
          </p>
        </div>
      )}

      {/* ── Title collision ──
          There is no Overwrite branch. Titles are permanent, so the only
          resolution is a different one; offering a button that can't work
          would just produce another 409 on click. */}
      {saveState === "conflict" && (
        <div className="rounded-lg border-2 border-attn bg-panel px-4 py-3 space-y-2">
          <p className="text-base font-bold text-ink leading-snug">
            {conflictMine
              ? `You already saved a template titled “${titleDraft.trim()}”`
              : `Someone already saved a template titled “${titleDraft.trim()}”`}
          </p>
          <p className="text-sm text-ink-soft leading-relaxed">
            Titles are shared across everyone and permanent, so this one is taken
            for good. Pick a different title — if this is a reworked version of
            that template, something like &ldquo;{titleDraft.trim()} v2&rdquo;
            keeps the two next to each other in the list.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => setSaveState("naming")}
              className="text-sm uppercase tracking-[0.14em] font-bold px-4 py-2 rounded-lg border-2 border-cta bg-cta hover:bg-cta-dark text-white transition-colors"
            >
              Pick another title
            </button>
            <button
              type="button"
              onClick={() => {
                setSaveState("idle");
                setTitleDraft("");
              }}
              className="text-sm font-bold text-ink-soft hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Curate: admin delete, whole library ── */}
      {manageOpen && isAdmin && ordered.length > 0 && (
        <ul className="rounded-lg border border-line bg-well/60 divide-y divide-line">
          {ordered.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="flex-1 min-w-48">
                <span className="block text-base text-ink font-semibold truncate">
                  {p.title}
                  {p.authorIsMe && (
                    <span className="ml-2 text-sm font-bold text-ink-soft">yours</span>
                  )}
                </span>
                <span className="block text-sm text-ink-soft truncate">
                  {p.authorName} · {formatByDate(p.createdAt)} · used {p.useCount}×
                </span>
              </span>
              <VoteButton prompt={p} onToggle={toggleVote} compact />
              {/* Red is reserved for genuinely destructive controls, and this
                  is one of them — it removes the template, and its votes, for
                  everybody. text-danger-ink, NOT text-danger — --color-danger
                  is 2.7:1 and fails AA as text (see the palette note in
                  styles/globals.css). */}
              <button
                type="button"
                onClick={() => void handleDelete(p)}
                title={`Delete "${p.title}" for everyone, permanently, along with its ${p.voteCount} upvote${p.voteCount === 1 ? "" : "s"}.`}
                className="text-sm font-bold text-danger-ink hover:text-danger-ink transition-colors"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {savedNotice && (
        <p className="text-sm text-accent font-semibold" role="status">
          {savedNotice}
        </p>
      )}
      {error && (
        <p className="text-sm text-attn bg-panel border border-attn rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
