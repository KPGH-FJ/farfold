import { invoke } from "@tauri-apps/api/core";
import { draftPersistence } from "./drafts";
import { pauseQueue } from "./queue";
import { applyConnectionLost } from "./session_projection";
import {
  hasActiveWork,
  hasPendingRequests,
  type ThreadState,
} from "./session_types";
import { hasUnconfirmedToolTail } from "./thread_attention";

export const STOPPED_WORK_CLOSE = {
  check: "检查能否关闭此对话的连接",
  checking: "正在检查…",
  review:
    "只关闭这段对话的连接。历史、未发送内容和待发消息保留，未确认的步骤仍显示结果未知。",
  confirm: "关闭此对话的连接",
  cancel: "返回",
  closing: "正在关闭连接…",
  blocked: "目前不能安全关闭这段对话的连接，请等待原步骤的结果。",
  unconfirmed: "尚未确认连接已关闭，原内容和状态仍保留。",
  failedNotice: "上次请求结果未知，当前连接仍保留一个任务名额。",
  stopReview:
    "请 Agent 关闭这段对话的连接。原对话、草稿和待发消息仍可找回。关闭后请先核对上次请求的结果，待发消息不会自动发送。",
} as const;

interface ConnectionOwner {
  connectionId: string;
  sessionId: string;
}

interface StoppedWorkOwner extends ConnectionOwner {
  toolCallId: string;
}

export interface StoppedWorkCloseReceipt extends StoppedWorkOwner {
  proofId: string;
}

interface ConnectionCloseTarget extends ConnectionOwner {
  /** Local presentation identity; it never goes to the Agent. */
  turnItemId: string;
  key: string;
  agentId: string;
  cwd: string;
}

export interface StoppedWorkTarget
  extends ConnectionCloseTarget, StoppedWorkOwner {}
type FailedWorkTarget = ConnectionCloseTarget;
interface UnconfirmedStopTarget extends ConnectionCloseTarget {
  unconfirmedStop: true;
}
export type WorkCloseTarget =
  StoppedWorkTarget | FailedWorkTarget | UnconfirmedStopTarget;
export interface WorkCloseReceipt extends ConnectionOwner {
  toolCallId?: string;
  proofId: string;
}

/** A presentation check only. The backend owns all evidence of approval,
 * cancellation, work admission and release. */
export function stoppedWorkTarget(
  thread: ThreadState,
): StoppedWorkTarget | null {
  if (
    !thread.connectionId ||
    !thread.nativeSessionId ||
    thread.identity !== "established" ||
    thread.connectionLost ||
    thread.connectionOutcomeUnknown ||
    thread.openError ||
    thread.sourceError ||
    thread.historyUnavailable ||
    thread.uncertainPrompt ||
    thread.stopUnconfirmed ||
    thread.queuePaused !== "stopped" ||
    (thread.permissionConfigId && thread.permissionState !== "ready") ||
    thread.activeToolCallIds.length !== 1 ||
    !hasUnconfirmedToolTail(thread)
  )
    return null;
  for (let i = thread.items.length - 1; i >= 0; i--) {
    const item = thread.items[i];
    if (item.kind === "user") return null;
    if (item.kind !== "settled") continue;
    if (item.status !== "stopped" || item.stopReason !== "cancelled")
      return null;
    return {
      connectionId: thread.connectionId,
      sessionId: thread.nativeSessionId,
      toolCallId: thread.activeToolCallIds[0]!,
      turnItemId: item.id,
      key: thread.key,
      agentId: thread.agentId,
      cwd: thread.cwd,
    };
  }
  return null;
}

export function failedWorkTarget(thread: ThreadState): FailedWorkTarget | null {
  if (
    !thread.connectionId ||
    !thread.nativeSessionId ||
    thread.identity !== "established" ||
    thread.connectionLost ||
    !thread.connectionOutcomeUnknown ||
    thread.running ||
    thread.submitting ||
    thread.stopping ||
    thread.stopUnconfirmed ||
    thread.openError ||
    thread.sourceError ||
    thread.historyUnavailable ||
    thread.uncertainPrompt ||
    hasActiveWork(thread) ||
    hasPendingRequests(thread)
  )
    return null;
  for (let i = thread.items.length - 1; i >= 0; i--) {
    const item = thread.items[i];
    if (item.kind === "user") return null;
    if (item.kind !== "settled") continue;
    if (item.status !== "failed" || !item.failedWorkCloseAvailable) return null;
    return {
      connectionId: thread.connectionId,
      sessionId: thread.nativeSessionId,
      turnItemId: item.id,
      key: thread.key,
      agentId: thread.agentId,
      cwd: thread.cwd,
    };
  }
  return null;
}

export function unconfirmedStopTarget(
  thread: ThreadState,
): UnconfirmedStopTarget | null {
  const user = thread.items[thread.roundItemBase - 1];
  if (
    !thread.sessionOperations?.closeAfterUnconfirmedStop ||
    !thread.connectionId ||
    !thread.nativeSessionId ||
    thread.identity !== "established" ||
    thread.connectionLost ||
    !thread.running ||
    !thread.stopUnconfirmed ||
    thread.stopping ||
    thread.submitting ||
    thread.openError ||
    thread.sourceError ||
    thread.historyUnavailable ||
    thread.uncertainPrompt ||
    hasActiveWork(thread) ||
    hasPendingRequests(thread) ||
    user?.kind !== "user"
  )
    return null;
  return {
    unconfirmedStop: true,
    connectionId: thread.connectionId,
    sessionId: thread.nativeSessionId,
    turnItemId: user.id,
    key: thread.key,
    agentId: thread.agentId,
    cwd: thread.cwd,
  };
}

function matchesWork(
  expected: WorkCloseTarget,
  receipt: (ConnectionOwner & { toolCallId?: string }) | null,
): boolean {
  return (
    receipt?.connectionId === expected.connectionId &&
    receipt.sessionId === expected.sessionId &&
    receipt.toolCallId ===
      ("toolCallId" in expected ? expected.toolCallId : undefined)
  );
}

function validWorkCloseProof(
  expected: WorkCloseTarget,
  receipt: WorkCloseReceipt | null,
): receipt is WorkCloseReceipt {
  return (
    matchesWork(expected, receipt) &&
    typeof receipt?.proofId === "string" &&
    /^[0-9]{1,20}$/.test(receipt.proofId)
  );
}

export function currentWorkClose(
  thread: ThreadState,
  expected: WorkCloseTarget,
): boolean {
  const current =
    "toolCallId" in expected
      ? stoppedWorkTarget(thread)
      : "unconfirmedStop" in expected
        ? unconfirmedStopTarget(thread)
        : failedWorkTarget(thread);
  return (
    current?.turnItemId === expected.turnItemId &&
    current.key === expected.key &&
    current.agentId === expected.agentId &&
    current.cwd === expected.cwd &&
    matchesWork(expected, current)
  );
}

function applyUnconfirmedStopClose(
  thread: ThreadState,
  target: UnconfirmedStopTarget,
): boolean {
  // A real terminal can be delivered while the confirmed close is in flight.
  // Accept the close for the same original message without overwriting it.
  const currentUser = thread.items[thread.roundItemBase - 1];
  if (
    thread.connectionLost ||
    thread.connectionId !== target.connectionId ||
    thread.nativeSessionId !== target.sessionId ||
    thread.key !== target.key ||
    thread.agentId !== target.agentId ||
    thread.cwd !== target.cwd ||
    currentUser?.kind !== "user" ||
    currentUser.id !== target.turnItemId
  )
    return false;
  const unresolved =
    thread.running ||
    thread.stopUnconfirmed ||
    thread.connectionOutcomeUnknown ||
    hasActiveWork(thread);
  applyConnectionLost(thread, "user");
  thread.connectionOutcomeUnknown = false;
  thread.historicalOutcomeUnknown ||= unresolved;
  pauseQueue(thread, thread.workEnabled ? "stopped" : "work_disabled");
  return true;
}

/** Only called with a typed response to the explicit IPC action. The actual
 * tool envelope is untouched; its outcome and saved input remain available. */
export function applyStoppedWorkClose(
  thread: ThreadState,
  expected: StoppedWorkTarget,
  approved: WorkCloseReceipt,
  receipt: WorkCloseReceipt,
): boolean {
  // A location policy can pause sending while the exact close is in flight.
  const workDisabled = thread.queuePaused === "work_disabled";
  if (
    !validWorkCloseProof(expected, approved) ||
    !validWorkCloseProof(expected, receipt) ||
    approved.proofId !== receipt.proofId ||
    !currentWorkClose(
      workDisabled ? { ...thread, queuePaused: "stopped" } : thread,
      expected,
    )
  )
    return false;
  thread.activeToolCallIds = [];
  applyConnectionLost(thread, "user");
  thread.historicalOutcomeUnknown = true;
  pauseQueue(thread, workDisabled ? "work_disabled" : "stopped");
  return true;
}

function applyFailedWorkClose(
  thread: ThreadState,
  expected: FailedWorkTarget,
): boolean {
  // A separate process-ended notification can arrive before the command reply.
  // It is accepted only for the same live identity and the same failed turn.
  if (
    !currentWorkClose(
      thread.connectionLost ? { ...thread, connectionLost: false } : thread,
      expected,
    )
  )
    return false;
  thread.processEndedConnectionId = expected.connectionId;
  thread.connectionOutcomeUnknown = false;
  applyConnectionLost(thread, "user");
  thread.historicalOutcomeUnknown = true;
  pauseQueue(thread, thread.workEnabled ? "stopped" : "work_disabled");
  return true;
}

export class WorkConnectionClosures {
  private closing = new WeakSet<ThreadState>();

  constructor(
    private owns: (thread: ThreadState) => boolean,
    private publish: (thread: ThreadState) => void,
    private delivery?: (
      thread: ThreadState,
    ) => { settle(deadline: number): Promise<void> } | undefined,
  ) {}

  async check(
    thread: ThreadState,
    target: WorkCloseTarget,
  ): Promise<WorkCloseReceipt | null> {
    if (
      !this.owns(thread) ||
      !currentWorkClose(thread, target) ||
      this.closing.has(thread)
    )
      return null;
    const { agentId, cwd, sessionId, connectionId } = target;
    const proof = await invoke<WorkCloseReceipt | null>(
      "toolCallId" in target
        ? "session_check_unapproved_stopped_close"
        : "unconfirmedStop" in target
          ? "session_check_unconfirmed_stop_close"
          : "prepare_failed_work_close",
      { agentId, cwd, sessionId, connectionId },
    );
    return this.owns(thread) &&
      currentWorkClose(thread, target) &&
      validWorkCloseProof(target, proof)
      ? proof
      : null;
  }

  async close(
    thread: ThreadState,
    target: WorkCloseTarget,
    proof: WorkCloseReceipt,
  ): Promise<void> {
    if (
      !this.owns(thread) ||
      !currentWorkClose(thread, target) ||
      !validWorkCloseProof(target, proof) ||
      this.closing.has(thread)
    )
      throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
    this.closing.add(thread);
    try {
      const delivery =
        "unconfirmedStop" in target ? this.delivery?.(thread) : undefined;
      if ("unconfirmedStop" in target && this.delivery && !delivery)
        throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      await draftPersistence.flush();
      if (!this.owns(thread) || !currentWorkClose(thread, target))
        throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      const { agentId, cwd, sessionId, connectionId } = target;
      const args = {
        agentId,
        cwd,
        sessionId,
        connectionId,
        proofId: proof.proofId,
      };
      const receipt = await ("toolCallId" in target
        ? invoke<StoppedWorkCloseReceipt>("session_close_unapproved_stopped", {
            ...args,
            toolCallId: target.toolCallId,
          })
        : invoke<WorkCloseReceipt>(
            "unconfirmedStop" in target
              ? "session_close_unconfirmed_stop"
              : "close_failed_work",
            args,
          ));
      if (
        !this.owns(thread) ||
        !validWorkCloseProof(target, receipt) ||
        proof.proofId !== receipt.proofId
      )
        throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      if (delivery) {
        // Events from the closed route, including a preceding real terminal,
        // must be consumed before we close its renderer-owned delivery queue.
        await delivery.settle(performance.now() + 5_000);
        if (!this.owns(thread) || this.delivery?.(thread) !== delivery)
          throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      }
      const applied =
        "toolCallId" in target
          ? applyStoppedWorkClose(thread, target, proof, receipt)
          : "unconfirmedStop" in target
            ? applyUnconfirmedStopClose(thread, target)
            : applyFailedWorkClose(thread, target);
      if (!applied) throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      this.publish(thread);
    } finally {
      this.closing.delete(thread);
    }
  }
}
