import {
  composerDrafts,
  draftPersistence,
  type ComposerDraft,
  type PendingConversation,
} from "./drafts";
import { threads, type ThreadState } from "./sessions";

export interface PendingAttempt {
  draftKey: string;
  snapshot: ComposerDraft;
  target: PendingConversation;
  clearOnAccepted: boolean;
}

/** Save the actual opened target before any first-message dispatch. */
export async function rememberPendingConversation(
  draftKey: string,
  submitted: ComposerDraft,
  state: ThreadState,
): Promise<PendingAttempt> {
  const current = composerDrafts.read(draftKey);
  if (!current.sendPending || current.pendingConversation)
    throw new Error("输入状态已变化，消息尚未发送，请检查后再试");
  const target: PendingConversation = {
    agentId: state.agentId,
    cwd: state.cwd,
    nativeSessionId: state.nativeSessionId,
    service: state.service
      ? { id: state.service.id, model: state.service.model }
      : undefined,
    serviceRevision: state.serviceContext,
  };
  const clearOnAccepted = composerDrafts.read(draftKey) === submitted;
  composerDrafts.update(draftKey, (draft) => ({
    ...draft,
    sendPending: true,
    pendingConversation: target,
  }));
  const attempt = {
    draftKey,
    snapshot: composerDrafts.read(draftKey),
    target,
    clearOnAccepted,
  };
  try {
    await draftPersistence.flush();
    if (composerDrafts.read(draftKey).pendingConversation !== target)
      throw new Error("输入状态已变化，消息尚未发送，请检查后再试");
    return attempt;
  } catch (error) {
    finishPendingConversation(attempt, "rejected");
    throw error;
  }
}

/** A later edit inherits the target marker but never becomes the sent input. */
export function finishPendingConversation(
  attempt: PendingAttempt,
  outcome: "accepted" | "rejected" | "unknown",
) {
  if (outcome === "unknown") return;
  const current = composerDrafts.read(attempt.draftKey);
  if (current.pendingConversation !== attempt.target) return;
  if (
    outcome === "accepted" &&
    attempt.clearOnAccepted &&
    current === attempt.snapshot
  ) {
    composerDrafts.clear(attempt.draftKey);
  } else {
    composerDrafts.update(attempt.draftKey, (draft) => ({
      ...draft,
      sendPending: false,
      pendingConversation: undefined,
    }));
  }
}

/** Recovery never consults the currently selected Agent/source or sends input. */
export async function recoverPendingConversation(
  target: PendingConversation,
): Promise<string> {
  const key = `${target.agentId}:${target.cwd}:${target.nativeSessionId}`;
  const existing = threads.thread(key);
  if (existing && !existing.connectionLost && !existing.openError) return key;
  const restored = await threads.open({
    agentId: target.agentId,
    cwd: target.cwd,
    nativeSessionId: target.nativeSessionId,
    service: target.service,
    serviceRevision: target.serviceRevision,
  });
  return restored.key;
}

/** Called only by the explicit abandonment confirmation; input stays intact. */
export function abandonPendingConversation(
  draftKey: string,
  target: PendingConversation,
) {
  if (composerDrafts.read(draftKey).pendingConversation !== target) return;
  composerDrafts.update(draftKey, (draft) => ({
    ...draft,
    sendPending: false,
    pendingConversation: undefined,
  }));
}
