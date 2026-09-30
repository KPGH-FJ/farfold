import {
  hasActiveTools,
  hasPendingRequests,
  type ThreadState,
} from "./session_types";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";

export interface AuthenticationWorkBlocker {
  key: string;
  title: string;
  reason: string;
  canOpen: boolean;
}

function workReason(thread: ThreadState): string | null {
  if (
    thread.stopUnconfirmed ||
    thread.uncertainPrompt ||
    thread.connectionOutcomeUnknown ||
    thread.permissionState === "unknown"
  )
    return S.workUnknown;
  if (hasPendingRequests(thread)) return S.workDecision;
  if (thread.stopping) return S.workStopping;
  if (thread.submitting) return S.workSending;
  if (thread.reconnecting) return S.workConnecting;
  if (thread.configuring) return S.workChanging;
  if (thread.running) return S.workRunning;
  if (hasActiveTools(thread)) return S.workTools;
  return null;
}

/** Authentication currently reconnects all of this Agent's connections, including
 * API sources. The backend remains authoritative for admission and races. */
export function authenticationWorkBlockers(
  agentId: string,
  threads: Iterable<ThreadState>,
): AuthenticationWorkBlocker[] {
  return [...threads].flatMap((thread) => {
    if (thread.agentId !== agentId) return [];
    const reason = workReason(thread);
    return reason
      ? [
          {
            key: thread.key,
            title: thread.title || S.workUntitled,
            reason,
            canOpen: thread.identity === "established",
          },
        ]
      : [];
  });
}
