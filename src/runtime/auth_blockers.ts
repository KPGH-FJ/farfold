import {
  hasActiveWork,
  hasUnconfirmedHistoryTools,
  hasPendingRequests,
  type ThreadState,
} from "./session_types";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";
import type { AuthTarget } from "./auth_activity";

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
    hasUnconfirmedHistoryTools(thread) ||
    thread.permissionState === "unknown"
  )
    return S.workUnknown;
  if (hasPendingRequests(thread)) return S.workDecision;
  if (thread.stopping) return S.workStopping;
  if (thread.submitting) return S.workSending;
  if (thread.reconnecting) return S.workConnecting;
  if (thread.configuring) return S.workChanging;
  if (thread.running) return S.workRunning;
  if (hasActiveWork(thread)) return S.workTools;
  return null;
}

/** Account mutations remain guarded across this Agent until shared credential
 * effects are known. Rechecking a completed login replaces only its own source.
 * The backend remains authoritative for admission and races. */
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

/** The account recheck command only replaces the original existing-settings
 * connection. API rechecks still use their existing reconnect flow. */
export function authenticationCheckBlockers(
  target: AuthTarget,
  threads: Iterable<ThreadState>,
): AuthenticationWorkBlocker[] {
  return authenticationWorkBlockers(
    target.agentId,
    target.source
      ? threads
      : [...threads].filter(
          (thread) =>
            thread.cwd === target.cwd &&
            !thread.serviceContext &&
            !thread.service,
        ),
  );
}
