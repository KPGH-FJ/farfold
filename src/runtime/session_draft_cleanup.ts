import { invoke } from "@tauri-apps/api/core";
import { hasPendingRequests, type ThreadState } from "./session_types";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";

function emptyDraft(s: ThreadState) {
  return (
    s.identity === "draft" &&
    !s.submitting &&
    !s.running &&
    !s.queued.length &&
    !s.items.length &&
    !hasPendingRequests(s) &&
    !s.uncertainPrompt
  );
}

/** Account actions require a close acknowledgment before dropping their preview. */
export async function discardEmptyDraft(
  s: ThreadState | undefined,
  forget: (state: ThreadState) => void,
  strict = false,
): Promise<void> {
  if (!s) return;
  if (
    !emptyDraft(s) ||
    (strict &&
      (s.stopping ||
        s.stopUnconfirmed ||
        s.connectionOutcomeUnknown ||
        s.configuring ||
        s.reconnecting ||
        s.permissionState === "unknown"))
  ) {
    if (strict) throw new Error(S.workHint);
    return;
  }
  if (!strict) forget(s);
  try {
    await invoke("session_close", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
      ...(strict ? { allowAlreadyClosed: true } : {}),
    });
  } catch {
    if (strict) throw new Error(S.preparationCloseFailed);
  }
  if (strict) {
    // Never delete newly admitted content while an asynchronous close was pending.
    if (!emptyDraft(s) || s.connectionOutcomeUnknown)
      throw new Error(S.workHint);
    forget(s);
  }
  await invoke("session_dismiss", {
    agentId: s.agentId,
    cwd: s.cwd,
    nativeSessionId: s.nativeSessionId,
  }).catch(() => undefined);
}
