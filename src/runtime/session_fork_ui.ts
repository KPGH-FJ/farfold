import type { SessionForkControl } from "./session_fork_control";
import { forkBlockReason } from "./session_fork";
import { forkControlOwner } from "./session_fork_activity";
import { SESSION_FORK_STRINGS as S } from "./session_fork_strings";
import type { ThreadState } from "./session_types";
import { threads } from "./sessions";
import {
  historyForkSelection,
  type HistoryForkSelection,
} from "./history_fork_point";

/** Each confirmation belongs to the exact live thread object and connection. */
export function sessionForkControl(
  thread: ThreadState | null,
  onOpened: (key: string) => void,
  selection?: HistoryForkSelection,
): SessionForkControl | null {
  if (!thread) return null;
  const operation = thread.forkOperation;
  if (
    !operation &&
    (thread.identity !== "established" ||
      !(selection
        ? thread.sessionOperations?.forkHistoricalPoint
        : thread.sessionOperations?.forkCurrentContext))
  )
    return null;
  const connectionId = thread.connectionId;
  const owner = forkControlOwner(thread);
  const point = operation?.historyPoint ?? selection?.point;
  const current = () =>
    threads.thread(thread.key) === thread &&
    thread.connectionId === connectionId &&
    forkControlOwner(thread) === owner &&
    (!selection ||
      Boolean(operation) ||
      historyForkSelection(thread, selection.item)?.point.messageId ===
        selection.point.messageId);
  const childKey = operation?.childKey;
  const child = childKey ? threads.thread(childKey) : undefined;
  const phase =
    operation?.status === "created_unavailable"
      ? "created-unavailable"
      : (operation?.status ?? "idle");
  const reasons: Record<string, string> = {
    not_dispatched: S.failedBeforeDispatch,
    busy: S.busy,
    configuration: S.configuration,
    permission: S.configuration,
    unsupported: S.unsupported,
    unavailable: S.unavailableOwner,
    browser_shared: S.browserShared,
    browser_connected: S.browserConnected,
    work_disabled: S.workDisabled,
    point_unavailable: S.pointUnavailable,
    point_ambiguous: S.pointAmbiguous,
    point_context_unavailable: S.pointContextUnavailable,
    point_read_failed: operation?.childSessionId
      ? S.pointMismatch
      : S.pointReadFailed,
    point_mismatch: S.pointMismatch,
  };
  return {
    owner,
    phase,
    blockedReason:
      phase === "idle" || phase === "rejected"
        ? forkBlockReason(thread, point)
        : undefined,
    child: operation?.childSessionId
      ? {
          nativeSessionId: operation.childSessionId,
          threadKey: child?.key,
          title: child?.title ?? undefined,
        }
      : undefined,
    message:
      operation?.reason === "message_backlog"
        ? S.messageBacklog
        : operation?.ownerEnded
          ? S.ownerEnded
          : operation?.reason && reasons[operation.reason]
            ? reasons[operation.reason]
            : operation && !operation.sourceReleased && phase !== "pending"
              ? S.sourceUnconfirmed
              : undefined,
    isCurrent: current,
    ...(point
      ? { historyPoint: { ...point, preview: selection?.preview } }
      : {}),
    start: () => {
      if (current()) void threads.forkCurrent(thread.key, point);
    },
    prepareNew:
      operation?.sourceReleased &&
      (!operation.historyPoint || Boolean(selection)) &&
      ["ready", "rejected"].includes(operation.status)
        ? () => {
            if (current())
              threads.prepareNewFork(thread.key, operation.operationId);
          }
        : undefined,
    openChild: child
      ? () => {
          if (current() && threads.thread(child.key) === child)
            onOpened(child.key);
        }
      : undefined,
  };
}
