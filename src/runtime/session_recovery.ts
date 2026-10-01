import { invoke } from "@tauri-apps/api/core";
import type { OpenInput, OpenResult } from "./sessions";
import type { ServiceIdentity } from "./credentials";
import type { ThreadState } from "./session_types";
import { applyUpdate, freshThreadState } from "./session_projection";
import { hasReadableMessages } from "./message_attachments";
import { STRINGS } from "./strings";
import { composerDrafts, hasUnsentWork } from "./drafts";

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

/** A failed frontend admission still leaves its acknowledged backend route open. */
export async function closeRecoveryRoute(state: ThreadState): Promise<void> {
  if (!state.historyUnavailable && !state.sourceError) return;
  await invoke("session_close", {
    agentId: state.agentId,
    cwd: state.cwd,
    sessionId: state.nativeSessionId,
    ...(state.historyUnavailable ? { allowAlreadyClosed: true } : {}),
  });
}

/** This only decides whether to validate cwd; it never selects a state by native id. */
const cwdValidationFailed = Symbol("cwdValidationFailed");
type ValidationPlaceholder = ThreadState & { [cwdValidationFailed]?: true };

export function needsCanonicalRecovery(
  input: OpenInput,
  states: ReadonlyMap<string, ThreadState>,
): boolean {
  const exact = states.get(
    `${input.agentId}:${input.cwd}:${input.nativeSessionId}`,
  );
  return Boolean(
    input.nativeSessionId &&
    ((exact?.openError &&
      !exact.historyUnavailable &&
      (exact as ValidationPlaceholder)[cwdValidationFailed]) ||
      (!exact &&
        [...states.values()].some(
          (state) =>
            state.agentId === input.agentId &&
            (state.resumed || state.historyUnavailable),
        ))),
  );
}

/** Only a default failed placeholder is disposable; input lives in separate stores too. */
function emptyFailedPlaceholder(state: ThreadState): boolean {
  const baseline = freshThreadState(
    state.key,
    state.agentId,
    state.cwd,
    state.nativeSessionId,
  );
  baseline.identity = "established";
  baseline.openError = state.openError;
  const unchanged = Object.entries(state).every(([key, value]) => {
    const initial = baseline[key as keyof ThreadState];
    return (
      value === initial ||
      (Array.isArray(value) &&
        Array.isArray(initial) &&
        !value.length &&
        !initial.length)
    );
  });
  return (
    unchanged &&
    !hasUnsentWork(state.key) &&
    [`session:${state.key}`, `queue-edit:${state.key}`].every((key) => {
      const draft = composerDrafts.read(key);
      return !draft.sendPending && !draft.pendingConversation;
    })
  );
}

/** Read only the existing command's validated cwd, without applying its work policy. */
export async function canonicalRecoveryOpen(
  input: OpenInput,
  states: Map<string, ThreadState>,
  open: (input: OpenInput) => Promise<ThreadState>,
  failed: (
    key: string,
    agent: string,
    cwd: string,
    native: string,
    error: string,
    unrecoverable?: boolean,
    preserveQueues?: boolean,
  ) => ThreadState,
): Promise<ThreadState> {
  const key = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
  const original = states.get(key);
  let cwd: string;
  try {
    const value = await invoke<{ cwd?: unknown } | null>("agent_work_get", {
      cwd: input.cwd,
    });
    if (
      typeof value?.cwd !== "string" ||
      !value.cwd.startsWith("/") ||
      value.cwd.includes("\0")
    )
      throw new Error(STRINGS.repair.reconnectFailed);
    cwd = value.cwd;
  } catch (error) {
    if (original && states.get(key) !== original) throw error;
    const placeholder = failed(
      `${input.agentId}:${input.cwd}:${input.nativeSessionId}`,
      input.agentId,
      input.cwd,
      input.nativeSessionId ?? "",
      STRINGS.repair.reconnectFailed,
      false,
      true,
    );
    (placeholder as ValidationPlaceholder)[cwdValidationFailed] = true;
    throw error;
  }
  if (original && states.get(key) !== original)
    throw new Error(STRINGS.repair.reconnectFailed);
  const placeholder = states.get(key);
  if (cwd !== input.cwd && placeholder) {
    if (!emptyFailedPlaceholder(placeholder)) {
      const message = STRINGS.repair.historyTargetHasContent;
      failed(
        key,
        input.agentId,
        input.cwd,
        input.nativeSessionId ?? "",
        message,
        false,
        true,
      );
      throw new Error(message);
    }
    states.delete(key);
  }
  return open({ ...input, cwd });
}
