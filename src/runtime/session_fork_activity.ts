import type { ThreadState } from "./session_types";

const owners = new WeakMap<
  ThreadState,
  { connectionId?: string; token: object }
>();
export function forkControlOwner(thread: ThreadState): object {
  let owner = owners.get(thread);
  if (!owner || owner.connectionId !== thread.connectionId) {
    owner = { connectionId: thread.connectionId, token: {} };
    owners.set(thread, owner);
  }
  return owner.token;
}
export function retireForkControlOwner(thread: ThreadState): void {
  owners.delete(thread);
}

/** A lost caller or connection cannot prove a dispatched copy was undone. */
export function hasActiveFork(
  thread: Pick<ThreadState, "forkOperation">,
): boolean {
  const operation = thread.forkOperation;
  return Boolean(
    operation &&
    !operation.ownerEnded &&
    (operation.status === "pending" ||
      operation.status === "unknown" ||
      (!operation.sourceReleased && operation.status !== "rejected")),
  );
}

export function validForkId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).byteLength <= 4096
  );
}

/** Only this operation's matching ordered local receipt may update its owner. */
export function receiveForkActivity(
  thread: ThreadState,
  event: Record<string, unknown>,
): boolean {
  const operation = thread.forkOperation;
  if (
    event.kind !== "forkActivity" ||
    !operation ||
    thread.connectionId !== operation.connectionId ||
    event.connectionId !== operation.connectionId ||
    event.sessionId !== operation.parentSessionId ||
    thread.nativeSessionId !== operation.parentSessionId ||
    event.operationId !== operation.operationId ||
    !["running", "unknown", "finished"].includes(String(event.state)) ||
    typeof event.sourceReleased !== "boolean" ||
    (event.childSessionId != null &&
      (!validForkId(event.childSessionId) ||
        event.childSessionId === operation.parentSessionId)) ||
    (event.indexed !== undefined && typeof event.indexed !== "boolean")
  )
    return false;
  if (
    operation.childSessionId &&
    event.childSessionId != null &&
    operation.childSessionId !== event.childSessionId
  )
    return false;
  if (validForkId(event.childSessionId))
    operation.childSessionId = event.childSessionId;
  if (event.indexed === true) operation.indexed = true;
  if (
    operation.settled ||
    operation.status === "ready" ||
    operation.status === "rejected"
  )
    return true;
  if (event.state === "unknown") operation.status = "unknown";
  if (event.state === "finished" && event.sourceReleased === true)
    operation.sourceReleased = true;
  return true;
}
