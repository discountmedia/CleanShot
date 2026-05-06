"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { createSession } from "@/lib/api";

/**
 * Top-level client providers.
 *
 * Today this only handles lazy session bootstrap — on first mount, if no
 * session_id is in the store, POST /api/v1/sessions to mint one.
 *
 * In the future this is the right place to mount a real auth provider
 * (Auth0/Clerk/WorkOS), error boundary, or analytics shim.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const session_id = useStore((s) => s.session_id);
  const setSession = useStore((s) => s.setSession);

  useEffect(() => {
    if (session_id) return;
    let cancelled = false;
    void (async () => {
      try {
        const { session_id: id } = await createSession();
        if (!cancelled) setSession(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[providers] failed to create session", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session_id, setSession]);

  return <>{children}</>;
}
