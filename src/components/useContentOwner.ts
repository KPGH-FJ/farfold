import { useEffect, useRef } from "react";
import type { ThreadState } from "../runtime/session_types";

/** A transient rendered navigation owner; returning to an earlier scope does not
 * revive its callbacks. It neither verifies nor reads a file. */
export function useContentOwner(
  thread: ThreadState | null,
  enabled: boolean,
  scope?: string | null,
) {
  const latest = useRef<{
    thread: ThreadState | null;
    key: string | null;
    cwd: string | null;
    enabled: boolean;
    scope: string | null | undefined;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (
    !latest.current ||
    latest.current.thread !== thread ||
    latest.current.key !== (thread?.key ?? null) ||
    latest.current.cwd !== (thread?.cwd ?? null) ||
    latest.current.enabled !== enabled ||
    latest.current.scope !== scope
  )
    latest.current = {
      thread,
      key: thread?.key ?? null,
      cwd: thread?.cwd ?? null,
      enabled,
      scope,
    };
  const owner = latest.current;
  return () =>
    thread !== null &&
    mounted.current &&
    latest.current === owner &&
    owner.enabled &&
    thread.key === owner.key &&
    thread.cwd === owner.cwd &&
    (scope === undefined ||
      (thread.artifactPaneTarget?.roundId ?? null) === scope);
}
