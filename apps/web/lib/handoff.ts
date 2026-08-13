// apps/web/lib/handoff.ts
// media-auditor → CleanShot import handoff: client-side token plumbing.
//
// The exchange token arrives in the URL **FRAGMENT**, never the query string.
// Fragments are not transmitted to the server, so the token cannot reach
// Vercel's function logs (app/page.tsx is `dynamic = "force-dynamic"`, so every
// landing is a logged server request) and cannot leak via a Referer header.
// The page reads it during the first render pass, exchanges it for a session,
// then strips it with history.replaceState so it is not in history, not in
// referrers, and not re-triggered by a back-navigation.
//
// Nothing in this file may ever log the token — not the value, not a prefix,
// not a truncation. Diagnosability comes from the server side, keyed by
// handoff_id.

/** Fragment key carrying the single-use exchange token. */
export const HANDOFF_HASH_KEY = "cs_handoff";

/**
 * Total time we will wait for the token exchange before abandoning it and
 * falling back to a normal empty session.
 *
 * 8000ms was PICKED, NOT MEASURED. The exchange should be a single Valkey/DB
 * read, so this ought to be wildly generous — but nobody has profiled the
 * endpoint in production yet.
 *
 * The number that actually matters is total time-to-usable-workspace on the
 * DEGRADE path, which is this timeout PLUS createSession(), with the operator
 * staring at a gate the whole time. Measure the exchange's p50/p99 on the first
 * prod smoke test and revisit. If the sum feels bad, the fix is firing the
 * exchange and createSession in parallel on the degrade path — not shaving
 * this cap.
 */
export const HANDOFF_EXCHANGE_TIMEOUT_MS = 8_000;

/**
 * Read the handoff token from the URL fragment.
 *
 * SSR-safe: returns null on the server, where `location` does not exist. This
 * is why the two pre-ready phases in Workspace MUST render identical markup —
 * the server initialises to "creating" and the client to "exchanging", and only
 * identical output keeps that from being a hydration mismatch on the app's root
 * component.
 */
export function readHandoffToken(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (hash.length < 2) return null;
  const token = new URLSearchParams(hash.slice(1)).get(HANDOFF_HASH_KEY);
  return token && token.trim() ? token : null;
}

/**
 * Remove the token from the address bar without adding a history entry.
 * Preserves any other fragment params. Called immediately after a successful
 * exchange — and also after a failed one, because a dead token in the URL is
 * still a token in the URL.
 */
export function stripHandoffToken(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has(HANDOFF_HASH_KEY)) return;
  params.delete(HANDOFF_HASH_KEY);
  const rest = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search + (rest ? `#${rest}` : ""),
  );
}

/**
 * Why an exchange did not produce a session.
 *
 *   "rejected"    — the server refused it: expired, or the signed-in user is
 *                   not the user who requested the handoff. Terminal; a retry
 *                   cannot help.
 *   "unavailable" — we could not get an answer: network failure, 5xx, or our
 *                   own timeout. The import may well be fine; we just can't
 *                   reach it.
 *
 * These are distinguished by HTTP STATUS CLASS only. The server's rejection
 * bodies are fixed strings by design (see the exchange route), so the client
 * cannot and must not try to tell "expired" from "user mismatch" — that
 * distinction lives in the server-side log, keyed by handoff_id.
 */
export type HandoffFailureReason = "rejected" | "unavailable";

export type HandoffExchangeResult =
  | {
      ok: true;
      sessionId: string;
      handoffId: string;
      /**
       * How many images ingest enqueued. A SEED FOR INITIAL PAINT ONLY — the
       * session read is authoritative for what actually exists. If crop
       * produced fewer images than this, the grid shows reality and the
       * shortfall is surfaced; it is never hidden behind a stuck skeleton.
       */
      expectedCount: number;
    }
  | { ok: false; reason: HandoffFailureReason };
