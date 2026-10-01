import type { OpenResult } from "./sessions";
import type { ServiceIdentity } from "./credentials";
import type { ThreadState } from "./session_types";
import { applyUpdate, freshThreadState } from "./session_projection";
import { hasReadableMessages } from "./message_attachments";
import { STRINGS } from "./strings";

/** Generated only after this app's successful resumed session_open reply. */
class HistoryReadFailure extends Error {
  constructor(
    readonly reason: "empty" | "incomplete",
    readonly failedKey: string,
  ) {
    super(
      reason === "empty"
        ? STRINGS.repair.historyEmpty
        : STRINGS.repair.historyUnavailable,
    );
  }
}

export function isHistoryReadFailure(error: unknown): boolean {
  return error instanceof HistoryReadFailure;
}

export function historyFailureKey(error: unknown): string | undefined {
  return error instanceof HistoryReadFailure ? error.failedKey : undefined;
}

/** Keep the existing admission boundary; a live disconnect is not an empty replay. */
export function requireReadableHistory(
  agentId: string,
  result: OpenResult,
  buffered: unknown[],
  complete: boolean,
  lost: boolean,
): void {
  if (lost) throw new Error(STRINGS.thread.connectionLost);
  const key = `${agentId}:${result.cwd}:${result.nativeSessionId}`;
  if (!complete) throw new HistoryReadFailure("incomplete", key);
  const replay = freshThreadState(
    "replay",
    agentId,
    result.cwd,
    result.nativeSessionId,
  );
  for (const event of buffered) {
    if (event && typeof event === "object" && "update" in event)
      applyUpdate(replay, event.update);
  }
  if (!hasReadableMessages(replay.items))
    throw new HistoryReadFailure("empty", key);
}

interface RecoveryInput {
  agentId: string;
  cwd: string;
  nativeSessionId?: string;
}

export function recoveryTarget(input: RecoveryInput, result?: OpenResult) {
  const cwd = result?.resumed ? result.cwd : input.cwd;
  return {
    cwd,
    key: `${input.agentId}:${cwd}:${input.nativeSessionId}`,
    originalKey: `${input.agentId}:${input.cwd}:${input.nativeSessionId}`,
  };
}

function knownService(value: ServiceIdentity | undefined): boolean {
  return Boolean(
    value &&
    typeof value.id === "string" &&
    value.id &&
    typeof value.model === "string" &&
    value.model &&
    typeof value.fingerprint === "string" &&
    value.fingerprint,
  );
}

/** Preserve body, queues and existing guards; only publish the failed-open facts. */
export function retainRecoveryFailure(
  state: ThreadState,
  error: unknown,
  result?: OpenResult,
): void {
  let sourceKnown = knownService(state.service);
  if (result?.resumed && result.service !== undefined) {
    state.service = result.service ?? undefined;
    state.serviceContext = result.serviceContext ?? undefined;
    // Explicit null is the backend's confirmed existing-settings source.
    // A missing wire slot cannot authorize silently choosing that source.
    sourceKnown = result.service === null || knownService(state.service);
  }
  state.identity = "established";
  state.reconnecting = false;
  state.historyUnavailable =
    error instanceof HistoryReadFailure
      ? { reason: error.reason, sourceKnown }
      : null;
  state.unrecoverable =
    String(error).replace(/^Error:\s*/, "") === STRINGS.thread.notResumable;
  state.openError =
    error instanceof HistoryReadFailure
      ? error.message
      : state.unrecoverable
        ? STRINGS.thread.notResumable
        : STRINGS.repair.reconnectFailed;
  // A successful load with no observed loss supersedes the old connection flag.
  // Execution uncertainty and all history/config admission guards remain separate.
  if (state.historyUnavailable) {
    state.connectionLost = false;
    state.activeToolCallIds = [];
  } else if (!state.unrecoverable) state.connectionLost = true;
}

export function recoveryDraftService(state: ThreadState) {
  if (state.historyUnavailable && !state.historyUnavailable.sourceKnown)
    throw new Error(STRINGS.repair.newDraftFailed);
  return state.service;
}
