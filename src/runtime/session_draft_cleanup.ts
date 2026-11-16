import { invoke } from "@tauri-apps/api/core";
import { hasPendingRequests, type ThreadState } from "./session_types";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";

function emptyDraft(s: ThreadState) {
  return (
    s.identity === "draft" &&
    !s.submitting &&
    !s.running &&
    !s.configuring &&
    !s.sessionToolRecoveryRequired &&
    !s.queued.length &&
    !s.items.length &&
    !hasPendingRequests(s) &&
    !s.uncertainPrompt
  );
}

function idlePreparationRead(s: ThreadState) {
  return (
    s.identity === "draft" &&
    !s.resumed &&
    s.roundItemBase === 0 &&
    !s.service &&
    !s.serviceContext &&
    !s.submitting &&
    !s.running &&
    !s.queued.length &&
    !s.queuePaused &&
    !s.activeToolCallIds.length &&
    !hasPendingRequests(s) &&
    !s.uncertainPrompt &&
    !s.stopping &&
    !s.stopUnconfirmed &&
    !s.connectionOutcomeUnknown &&
    !s.configuring &&
    !s.reconnecting &&
    s.permissionState !== "unknown" &&
    s.permissionState !== "changing" &&
    s.items.every((item) => ["agent", "raw", "notice"].includes(item.kind))
  );
}

/** Retire only the preparation owner's never-prompted read. Startup content
 * stays available locally and in the Agent's history; it is never dismissed. */
export async function retirePreparationRead(
  s: ThreadState | undefined,
  owns: () => boolean,
  retire: (state: ThreadState, retain: boolean) => void,
): Promise<void> {
  const permitted = () => !!s && owns() && idlePreparationRead(s);
  if (!s || !permitted()) throw new Error(S.workHint);
  try {
    await invoke("session_close", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
      allowAlreadyClosed: true,
    });
  } catch {
    throw new Error(S.preparationCloseFailed);
  }
  // A new initializer is retained. Newly admitted work or a changed owner
  // must remain attached, even if the earlier close has been acknowledged.
  if (!permitted()) throw new Error(S.workHint);
  const retain = s.items.length > 0;
  retire(s, retain);
  if (!retain)
    await invoke("session_dismiss", {
      agentId: s.agentId,
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
    }).catch(() => undefined);
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
