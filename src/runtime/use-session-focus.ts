import { useEffect, useRef } from "react";
import { focusHostSession } from "./host-session-metadata";

// Only user-visible workspace activation changes focus. Initial hydration and
// background Runtime reconciliation must not overwrite the restored selection.
export function useSessionFocus(
  active: boolean,
  sessionId: string | null,
  requestedSessionId: string | null,
  onError: (message: string) => void,
): void {
  const wasActive = useRef(active);
  useEffect(() => {
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (activated && sessionId && !requestedSessionId) {
      void focusHostSession(sessionId).catch((reason) =>
        onError(String(reason)),
      );
    }
  }, [active, sessionId, requestedSessionId, onError]);
}
