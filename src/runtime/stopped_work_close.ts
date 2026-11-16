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
export type WorkCloseTarget = StoppedWorkTarget | FailedWorkTarget;
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
      : failedWorkTarget(thread);
  return (
    current?.turnItemId === expected.turnItemId &&
    current.key === expected.key &&
    current.agentId === expected.agentId &&
    current.cwd === expected.cwd &&
    matchesWork(expected, current)
  );
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
        : invoke<WorkCloseReceipt>("close_failed_work", args));
      if (
        !this.owns(thread) ||
        !validWorkCloseProof(target, receipt) ||
        proof.proofId !== receipt.proofId
      )
        throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      const applied =
        "toolCallId" in target
          ? applyStoppedWorkClose(thread, target, proof, receipt)
          : applyFailedWorkClose(thread, target);
      if (!applied) throw new Error(STOPPED_WORK_CLOSE.unconfirmed);
      this.publish(thread);
    } finally {
      this.closing.delete(thread);
    }
  }
}
