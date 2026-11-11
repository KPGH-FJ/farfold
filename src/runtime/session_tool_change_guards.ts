import { TOOL_RECOVERY } from "./session_tool_recovery_strings";
import { configurationInputBusy } from "./config_check";
import { configChangeBusy } from "./protected_config";
import type { ThreadState } from "./session_types";

interface Owner {
  operationId: string;
  identity: string;
}

const identity = (s: ThreadState) =>
  JSON.stringify([
    s.key,
    s.agentId,
    s.cwd,
    s.nativeSessionId,
    s.connectionId,
    s.serviceContext ?? null,
    s.service ?? null,
  ]);

/** Own the existing shared configuration gate for one exact user operation.
 * A dismissed view, timeout or ended transport never settles this owner. */
export class SessionToolChangeGuards {
  private owners = new WeakMap<ThreadState, Owner>();
  private listeners = new Set<() => void>();

  constructor(
    private hooks: {
      current: (key: string) => ThreadState | undefined;
      emit: (key: string) => void;
      saved?: (state: ThreadState) => void;
    },
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(s: ThreadState) {
    this.hooks.emit(s.key);
    for (const listener of [...this.listeners]) listener();
  }

  claim(s: ThreadState, operationId: string): boolean {
    if (
      this.hooks.current(s.key) !== s ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId) ||
      !s.nativeSessionId ||
      !s.connectionId ||
      this.owners.has(s) ||
      configChangeBusy(s) ||
      configurationInputBusy(s) ||
      (s.queued.length > 0 && !s.queuePaused)
    )
      return false;
    this.owners.set(s, { operationId, identity: identity(s) });
    s.configuring = true;
    this.publish(s);
    return true;
  }

  has(s: ThreadState, operationId?: string): boolean {
    const owner = this.owners.get(s);
    return Boolean(
      owner && (!operationId || owner.operationId === operationId),
    );
  }

  markUnknown(s: ThreadState, operationId: string): boolean {
    if (!this.has(s, operationId) || this.hooks.current(s.key) !== s)
      return false;
    s.sessionToolRecoveryRequired = true;
    this.publish(s);
    return true;
  }

  /** A matching native persistence receipt establishes the conversation, not
   * the tool outcome or current model. Keep all existing pauses intact. */
  saved(s: ThreadState, operationId: string): boolean {
    const owner = this.owners.get(s);
    if (
      !owner ||
      owner.operationId !== operationId ||
      owner.identity !== identity(s) ||
      this.hooks.current(s.key) !== s ||
      !s.configuring
    )
      return false;
    if (s.identity !== "established") {
      s.identity = "established";
      this.hooks.saved?.(s);
      this.publish(s);
    }
    return true;
  }

  /** Only before invoke has been called. Remove the exact original object's
   * gate even if its display was replaced; never look up another state by key. */
  releaseUnsent(s: ThreadState, operationId: string): boolean {
    if (!this.has(s, operationId)) return false;
    this.owners.delete(s);
    s.configuring = false;
    s.sessionToolRecoveryRequired = false;
    this.publish(s);
    return true;
  }

  resolveRecovery(s: ThreadState, operationId: string): boolean {
    if (
      this.hooks.current(s.key) !== s ||
      !s.sessionToolRecoveryRequired ||
      (this.has(s) && !this.has(s, operationId))
    )
      return false;
    // Rechecking ended the previous route; never send again through that route.
    s.connectionLost = true;
    s.openError = TOOL_RECOVERY.resolved;
    if (this.has(s, operationId) && !this.settle(s, operationId)) return false;
    s.sessionToolRecoveryRequired = false;
    this.publish(s);
    return true;
  }

  /** Only a validated matching result may invoke this. Keep every other pause,
   * draft and queued message intact, and never drain the queue here. */
  settle(s: ThreadState, operationId: string): boolean {
    const owner = this.owners.get(s);
    if (
      !owner ||
      owner.operationId !== operationId ||
      owner.identity !== identity(s) ||
      this.hooks.current(s.key) !== s ||
      !s.configuring
    )
      return false;
    this.owners.delete(s);
    s.configuring = false;
    s.sessionToolRecoveryRequired = false;
    this.publish(s);
    return true;
  }
}
