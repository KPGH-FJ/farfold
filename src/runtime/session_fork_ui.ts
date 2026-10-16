import type { SessionForkControl } from "./session_fork_control";
import { forkBlockReason } from "./session_fork";
import { forkControlOwner } from "./session_fork_activity";
import { SESSION_FORK_STRINGS as S } from "./session_fork_strings";
import type { ThreadState } from "./session_types";
import { threads } from "./sessions";

/** Each confirmation belongs to the exact live thread object and connection. */
export function sessionForkControl(
  thread: ThreadState | null,
  onOpened: (key: string) => void,
): SessionForkControl | null {
  if (!thread) return null;
  const operation = thread.forkOperation;
  if (
    !operation &&
    (thread.identity !== "established" ||
      !thread.sessionOperations?.forkCurrentContext)
  )
    return null;
  const connectionId = thread.connectionId;
  const owner = forkControlOwner(thread);
  const current = () =>
    threads.thread(thread.key) === thread &&
    thread.connectionId === connectionId &&
    forkControlOwner(thread) === owner;
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
    work_disabled: S.workDisabled,
  };
  return {
    owner,
    phase,
    blockedReason:
      phase === "idle" || phase === "rejected"
        ? forkBlockReason(thread)
        : undefined,
    child: operation?.childSessionId
      ? {
          nativeSessionId: operation.childSessionId,
          threadKey: child?.key,
          title: child?.title ?? undefined,
        }
      : undefined,
    message: operation?.ownerEnded
      ? S.ownerEnded
      : operation?.reason && reasons[operation.reason]
        ? reasons[operation.reason]
        : operation && !operation.sourceReleased && phase !== "pending"
          ? S.sourceUnconfirmed
          : undefined,
    isCurrent: current,
    start: () => {
      if (current()) void threads.forkCurrent(thread.key);
    },
    prepareNew:
      operation?.sourceReleased &&
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
