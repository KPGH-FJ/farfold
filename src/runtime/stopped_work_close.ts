import { pauseQueue } from "./queue";
import { applyConnectionLost } from "./session_projection";
import type { ThreadState } from "./session_types";
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
} as const;

interface StoppedWorkOwner {
  connectionId: string;
  sessionId: string;
  toolCallId: string;
}

export interface StoppedWorkCloseReceipt extends StoppedWorkOwner {
  proofId: string;
}

export interface StoppedWorkTarget extends StoppedWorkOwner {
  /** Local presentation identity; it never goes to the Agent. */
  turnItemId: string;
  key: string;
  agentId: string;
  cwd: string;
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

export function matchesStoppedWork(
  expected: StoppedWorkOwner,
  receipt: StoppedWorkOwner | null | undefined,
): boolean {
  return (
    receipt?.connectionId === expected.connectionId &&
    receipt.sessionId === expected.sessionId &&
    receipt.toolCallId === expected.toolCallId
  );
}

export function validStoppedWorkProof(
  expected: StoppedWorkTarget,
  receipt: StoppedWorkCloseReceipt | null,
): receipt is StoppedWorkCloseReceipt {
  return (
    matchesStoppedWork(expected, receipt) &&
    typeof receipt?.proofId === "string" &&
    /^[0-9]{1,20}$/.test(receipt.proofId)
  );
}

export function currentStoppedWork(
  thread: ThreadState,
  expected: StoppedWorkTarget,
): boolean {
  const current = stoppedWorkTarget(thread);
  return (
    current?.turnItemId === expected.turnItemId &&
    current.key === expected.key &&
    current.agentId === expected.agentId &&
    current.cwd === expected.cwd &&
    matchesStoppedWork(expected, current)
  );
}

/** Only called with a typed response to the explicit IPC action. The actual
 * tool envelope is untouched; its outcome and saved input remain available. */
export function applyStoppedWorkClose(
  thread: ThreadState,
  expected: StoppedWorkTarget,
  approved: StoppedWorkCloseReceipt,
  receipt: StoppedWorkCloseReceipt,
): boolean {
  // A location policy can pause sending while the exact close is in flight.
  const workDisabled = thread.queuePaused === "work_disabled";
  if (
    !validStoppedWorkProof(expected, approved) ||
    !validStoppedWorkProof(expected, receipt) ||
    approved.proofId !== receipt.proofId ||
    !currentStoppedWork(
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
