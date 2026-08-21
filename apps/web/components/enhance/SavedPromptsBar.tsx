"use client";
// apps/web/components/enhance/SavedPromptsBar.tsx
//
// Save / insert / manage the operator's reusable enhance prompts.
//
// SPLIT ACROSS TWO ROWS (2026-08-21 layout pass). The insert dropdown sits up
// beside "Insert recommended prompt" so the two read as a pair, and the save +
// manage controls sit below the textarea, right-aligned. Because those are two
// different rows in EnhancePanel's tree, the shared state moved OUT into
// `useSavedPrompts()` — EnhancePanel calls it once and hands the same state to
// both pieces. Two independent components would each fetch their own list, and
// saving would not refresh the dropdown.
//
// Enhance is prompt-first, so a good prompt is real work — and before this it
// was retyped from scratch every session. This bar sits directly under the
// prompt box: SAVE PROMPT TO PROFILE on one side, a titled dropdown on the
// other, and rename / delete behind a Manage disclosure.
//
// Two deliberate choices worth knowing:
//
//  • The title is collected in an INLINE field, not window.prompt(). A native
//    prompt is unstyled, ignores the house palette entirely, and is blocked
//    outright in some browsers — a save that silently does nothing is worse
//    than one that takes an extra click.
//
//  • Overwrite is never assumed. A colliding title comes back from the server
//    as a 409 and the user picks overwrite or rename. Choosing for them would
//    either destroy a prompt or quietly create a near-duplicate.

import { useCallback, useEffect, useId, useState } from "react";

import {
  PromptTitleConflictError,
  deleteSavedPrompt,
  listSavedPrompts,
  renameSavedPrompt,
  saveSavedPrompt,
  type SavedPrompt,
} from "../../lib/api";

/**
 * The saved-prompt state, owned in ONE place and shared by both halves of the
 * split UI. EnhancePanel calls this once.
 */
export function useSavedPrompts() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const rows = await listSavedPrompts(signal);
      setPrompts(rows);
      setError(null);
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Couldn't load saved prompts");
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

  return {
    prompts, loading, error, setError,
    savedNotice, setSavedNotice, refresh,
  };
}

export type SavedPromptsState = ReturnType<typeof useSavedPrompts>;

interface SavedPromptSelectProps {
  state: SavedPromptsState;
  /** Current contents of the prompt field — drives the overwrite confirm. */
  currentPrompt: string;
  /** Insert a saved prompt's text into the field, replacing what's there. */
  onInsert: (body: string) => void;
}

/**
 * The insert dropdown. Rendered beside "Insert recommended prompt" so the two
 * ways of filling the prompt box sit together.
 */
export function SavedPromptSelect({
  state, currentPrompt, onInsert,
}: SavedPromptSelectProps) {
  const selectId = useId();
  const { prompts, loading, setSavedNotice } = state;
  const hasPrompt = currentPrompt.trim().length > 0;

  const handleInsert = (id: string) => {
    const chosen = prompts.find((p) => p.id === id);
    if (!chosen) return;
    // Inserting replaces the box. If there's text in there that isn't already
    // this prompt, the operator is about to lose it, so ask first.
    if (hasPrompt && currentPrompt.trim() !== chosen.body.trim()) {
      const ok = window.confirm(
        `Replace the prompt currently in the box with "${chosen.title}"?\n\n` +
        `Anything you've typed and not saved will be lost.`,
      );
      if (!ok) return;
    }
    // A copy of the text, not a live link — editing the box never writes back
    // to the saved row.
    onInsert(chosen.body);
    setSavedNotice(`Inserted "${chosen.title}" — edits here won't change the saved copy`);
  };

  return (
    <select
      id={selectId}
      aria-label="Insert a saved prompt"
      value=""
      disabled={loading || prompts.length === 0}
      onChange={(e) => {
        if (e.target.value) handleInsert(e.target.value);
        // Reset to the placeholder so picking the same prompt twice in a row
        // still fires onChange.
        e.target.value = "";
      }}
      /* py-3 matches the recommended-prompt button's height so the pair sits on
         one baseline. */
      /* max-w-full + min-w-0: a select won't shrink below its widest option by
         default, so a long saved-prompt title would push this row wider than
         the phone viewport. */
      className="max-w-full min-w-0 bg-panel border border-line rounded-lg px-3 py-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-cta disabled:opacity-60"
    >
      <option value="">
        {loading
          ? "Loading…"
          : prompts.length === 0
            ? "No saved prompts yet"
            : "Insert a saved prompt…"}
      </option>
      {prompts.map((p) => (
        <option key={p.id} value={p.id}>
          {p.title}
        </option>
      ))}
    </select>
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
    prompts, error, setError, savedNotice, setSavedNotice, refresh,
  } = state;

  // Save flow: idle → naming (inline title field) → conflict (overwrite/rename)
  const [saveState, setSaveState] = useState<"idle" | "naming" | "conflict">("idle");
  const [titleDraft, setTitleDraft] = useState("");
  const [isSaving,   setIsSaving]   = useState(false);

  const [manageOpen, setManageOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const hasPrompt = currentPrompt.trim().length > 0;

  // ─── Save ────────────────────────────────────────────────────────────────

  const commitSave = async (overwrite: boolean) => {
    const title = titleDraft.trim();
    if (!title || !hasPrompt) return;
    setIsSaving(true);
    setError(null);
    try {
      await saveSavedPrompt({ title, body: currentPrompt, overwrite });
      setSaveState("idle");
      setTitleDraft("");
      setSavedNotice(`Saved as "${title}"`);
      await refresh();
    } catch (err: unknown) {
      if (err instanceof PromptTitleConflictError) {
        // Not an error state — it's a question. Ask it.
        setSaveState("conflict");
      } else {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Manage ──────────────────────────────────────────────────────────────

  const commitRename = async (id: string) => {
    const title = renameDraft.trim();
    if (!title) return;
    try {
      await renameSavedPrompt(id, title);
      setRenamingId(null);
      setRenameDraft("");
      await refresh();
    } catch (err: unknown) {
      setError(
        err instanceof PromptTitleConflictError
          ? `You already have a prompt titled "${title}".`
          : err instanceof Error ? err.message : "Rename failed",
      );
    }
  };

  const handleDelete = async (p: SavedPrompt) => {
    const ok = window.confirm(
      `Delete the saved prompt "${p.title}"?\n\nThis can't be undone.`,
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
      {/* Manage on the left, Save on the right. `justify-end` + `mr-auto` on
          Manage keeps Save hard against the right edge without leaving a hole
          where the insert dropdown used to sit — that moved up beside "Insert
          recommended prompt". On a narrow screen `flex-wrap` drops Save onto
          its own line rather than squeezing the pair. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {prompts.length > 0 && (
          <button
            type="button"
            onClick={() => setManageOpen((v) => !v)}
            className="mr-auto text-sm font-bold text-ink-soft hover:text-ink transition-colors"
          >
            {manageOpen ? "Done managing" : "Manage"}
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
              ? "Save the prompt currently in the box to your profile"
              : "Write a prompt first — there's nothing to save yet"
          }
          className={`text-sm uppercase tracking-[0.14em] font-bold px-4 py-2.5 rounded-lg border-2 transition-colors ${
            hasPrompt && saveState === "idle"
              ? "border-accent bg-accent hover:bg-accent/85 text-header-bg"
              : "border-line bg-panel text-ink-faint cursor-not-allowed"
          }`}
        >
          Save prompt to profile
        </button>
      </div>

      {/* ── Inline title field ── */}
      {saveState === "naming" && (
        <div className="rounded-lg border-2 border-cta bg-panel px-4 py-3 space-y-2">
          <label
            htmlFor={titleFieldId}
            className="block text-sm uppercase tracking-[0.14em] font-bold text-ink"
          >
            Title this prompt
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
                  void commitSave(false);
                }
                if (e.key === "Escape") setSaveState("idle");
              }}
              placeholder="e.g. Yard units, heavy rust"
              maxLength={120}
              className="flex-1 min-w-56 bg-well border border-line rounded-md px-3 py-2 text-base text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-cta"
            />
            <button
              type="button"
              onClick={() => void commitSave(false)}
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
            A title is required — it&apos;s how you&apos;ll find this prompt in the dropdown.
          </p>
        </div>
      )}

      {/* ── Title collision ── */}
      {saveState === "conflict" && (
        <div className="rounded-lg border-2 border-attn bg-panel px-4 py-3 space-y-2">
          <p className="text-base font-bold text-ink leading-snug">
            You already have a prompt titled &ldquo;{titleDraft.trim()}&rdquo;
          </p>
          <p className="text-sm text-ink-soft leading-relaxed">
            Overwrite it with the prompt currently in the box, or pick a different title.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void commitSave(true)}
              disabled={isSaving}
              className="text-sm uppercase tracking-[0.14em] font-bold px-4 py-2 rounded-lg border-2 border-cta bg-cta hover:bg-cta-dark text-white transition-colors"
            >
              {isSaving ? "Overwriting…" : "Overwrite"}
            </button>
            <button
              type="button"
              onClick={() => setSaveState("naming")}
              className="text-sm uppercase tracking-[0.14em] font-bold px-4 py-2 rounded-lg border-2 border-line bg-panel hover:bg-panel-hi text-ink transition-colors"
            >
              Rename
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

      {/* ── Manage: rename + delete ── */}
      {manageOpen && prompts.length > 0 && (
        <ul className="rounded-lg border border-line bg-well/60 divide-y divide-line">
          {prompts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              {renamingId === p.id ? (
                <>
                  <input
                    type="text"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renameDraft.trim()) {
                        e.preventDefault();
                        void commitRename(p.id);
                      }
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    maxLength={120}
                    className="flex-1 min-w-48 bg-panel border border-line rounded-md px-3 py-1.5 text-base text-ink focus:outline-none focus:ring-2 focus:ring-cta"
                  />
                  <button
                    type="button"
                    onClick={() => void commitRename(p.id)}
                    disabled={!renameDraft.trim()}
                    className="text-sm font-bold text-accent hover:text-accent disabled:text-ink-faint transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="text-sm font-bold text-ink-soft hover:text-ink transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-48 text-base text-ink font-semibold truncate" title={p.title}>
                    {p.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(p.id);
                      setRenameDraft(p.title);
                    }}
                    className="text-sm font-bold text-ink-soft hover:text-ink transition-colors"
                  >
                    Rename
                  </button>
                  {/* Red is reserved for genuinely destructive controls, and
                      this is one of them. text-danger-ink, NOT text-danger —
                      --color-danger is 2.7:1 and fails AA as text (see the
                      palette note in styles/globals.css). */}
                  <button
                    type="button"
                    onClick={() => void handleDelete(p)}
                    className="text-sm font-bold text-danger-ink hover:text-danger-ink transition-colors"
                  >
                    Delete
                  </button>
                </>
              )}
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
