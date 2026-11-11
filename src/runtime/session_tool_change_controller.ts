import type { ThreadState } from "./session_types";
import { configChangeBusy } from "./protected_config";
import {
  sessionToolInventoryCapability,
  validSessionToolsOperationId,
  type SessionToolsTarget,
} from "./session_tools_types";
import {
  sessionToolChangePort,
  type SessionToolChangePort,
} from "./session_tool_change";
import {
  parseSessionToolChangeOperation,
  sessionToolChangeFailure,
  sessionToolChangeRejection,
  validSessionToolChange,
  type SessionManagedTool,
  type SessionToolChange,
  type SessionToolChangeCode,
  type SessionToolChangeOperation,
  type SessionToolChangeRequest,
} from "./session_tool_change_types";
import {
  claimSessionToolChange,
  settleSessionToolChange,
  hasSessionToolChange,
  subscribeSessionToolChange,
  markSessionToolChangeUnknown,
  releaseUnsentSessionToolChange,
} from "./session_tool_change_guard";

export interface SessionToolChangeSnapshot {
  operation: SessionToolChangeOperation | null;
  kind: SessionToolChange["kind"] | null;
  items: SessionManagedTool[];
  itemsRead: boolean;
  listing: boolean;
  checking: boolean;
  unresolved: boolean;
  recovered: boolean;
  error: SessionToolChangeCode | null;
}
export interface SessionToolChangeGuard {
  claim(owner: ThreadState, operationId: string): boolean;
  settle(owner: ThreadState, operationId: string): boolean;
  has(owner: ThreadState, operationId?: string): boolean;
  unknown(owner: ThreadState, operationId: string): boolean;
  unsent(owner: ThreadState, operationId: string): boolean;
  subscribe(listener: () => void): () => void;
}
const guard: SessionToolChangeGuard = {
  claim: claimSessionToolChange,
  settle: settleSessionToolChange,
  has: hasSessionToolChange,
  subscribe: subscribeSessionToolChange,
  unknown: markSessionToolChangeUnknown,
  unsent: releaseUnsentSessionToolChange,
};
const sourceOf = (s: ThreadState) =>
  JSON.stringify([
    s.serviceContext ?? null,
    s.service?.id ?? null,
    s.service?.fingerprint ?? null,
  ]);
const validPart = (v: unknown) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 8192 &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(v);

/** One exact conversation/connection, retained across panel mounts. No URL is
 * retained after dispatch, no automatic retry, and dismissal never cancels work. */
export class SessionToolChangeController {
  private snapshot: SessionToolChangeSnapshot = {
    operation: null,
    kind: null,
    items: [],
    itemsRead: false,
    listing: false,
    checking: false,
    unresolved: false,
    recovered: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly target: SessionToolsTarget;
  private readonly source: string;
  private readonly key: string;
  private request: SessionToolChangeRequest | null = null;
  private retired = false;
  private epoch = 0;
  private stopGuard?: () => void;
  constructor(
    private readonly owner: ThreadState,
    private current: () => ThreadState | undefined,
    private readonly port: SessionToolChangePort = sessionToolChangePort,
    private readonly protection: SessionToolChangeGuard = guard,
    private readonly waitMs = 12000,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.target = {
      agentId: owner.agentId,
      cwd: owner.cwd,
      sessionId: owner.nativeSessionId,
      connectionId: owner.connectionId ?? "",
    };
    this.source = sourceOf(owner);
    this.key = owner.key;
  }
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<SessionToolChangeSnapshot>) {
    if (this.retired) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of [...this.listeners]) listener();
  }
  matchesOwner(s: ThreadState | undefined): boolean {
    return (
      !this.retired &&
      s === this.owner &&
      s.key === this.key &&
      s.agentId === this.target.agentId &&
      s.cwd === this.target.cwd &&
      s.nativeSessionId === this.target.sessionId &&
      s.connectionId === this.target.connectionId &&
      sourceOf(s) === this.source &&
      Object.values(this.target).every(validPart)
    );
  }
  readonly isCurrent = () => this.matchesOwner(this.current());
  refreshCurrent(current: () => ThreadState | undefined) {
    this.current = current;
  }
  retireOwner() {
    this.retired = true;
    this.listeners.clear();
    this.stopGuard?.();
  }
  get blockedCode(): SessionToolChangeCode | null {
    if (!this.isCurrent()) return "changed";
    if (
      !sessionToolInventoryCapability(this.owner.sessionToolInventory)
        ?.management
    )
      return "unavailable";
    return configChangeBusy(this.owner) ||
      (this.owner.queued.length > 0 && !this.owner.queuePaused)
      ? "busy"
      : null;
  }
  private same(expected: SessionToolChangeRequest) {
    return this.isCurrent() && this.request === expected;
  }
  private stopProtectionWatch() {
    this.stopGuard?.();
    this.stopGuard = undefined;
  }
  private settle(expected: SessionToolChangeRequest) {
    this.stopProtectionWatch();
    if (this.snapshot.kind === "inspect") return true;
    return this.protection.settle(this.owner, expected.operationId);
  }
  private markUnknown(expected: SessionToolChangeRequest) {
    if (this.snapshot.kind !== "inspect")
      this.protection.unknown(this.owner, expected.operationId);
  }
  private accept(
    raw: unknown,
    expected: SessionToolChangeRequest,
    epoch: number,
  ) {
    if (!this.same(expected) || !this.snapshot.unresolved) return;
    let operation: SessionToolChangeOperation;
    try {
      operation = parseSessionToolChangeOperation(
        raw,
        expected,
        this.snapshot.kind!,
      );
    } catch {
      if (epoch === this.epoch) {
        this.markUnknown(expected);
        this.publish({
          error: "invalidResponse",
          checking: false,
          listing: false,
        });
      }
      return;
    }
    if (!operation.settled && epoch !== this.epoch) return;
    const ready =
      operation.state === "ready" &&
      (operation.kind === "inspect"
        ? !operation.mutationSent &&
          operation.persistence === "unreported" &&
          operation.activity === "unreported"
        : operation.mutationSent &&
          operation.persistence === "confirmed" &&
          (operation.kind === "addHttp"
            ? operation.activity === "toolsReported"
            : ["absentReported", "unreported"].includes(operation.activity)));
    const refused =
      operation.state === "failed" &&
      operation.settled &&
      !operation.mutationSent;
    if (operation.state === "ready" && !ready) {
      this.markUnknown(expected);
      this.publish({
        error: "invalidResponse",
        checking: false,
        listing: false,
      });
      return;
    }
    const released = (ready || refused) && this.settle(expected);
    if (
      !released &&
      (operation.state === "unknown" || operation.state === "failed")
    )
      this.markUnknown(expected);
    this.publish({
      operation,
      items: operation.items,
      itemsRead: operation.state === "ready" ? true : this.snapshot.itemsRead,
      unresolved: !released,
      checking: false,
      listing: false,
      error:
        operation.error?.code ??
        (operation.state === "unknown" ? "unknown" : null),
    });
  }
  private observe(
    expected: SessionToolChangeRequest,
    call: () => Promise<unknown>,
    admission = false,
  ) {
    const epoch = ++this.epoch;
    const timer = setTimeout(() => {
      if (
        epoch === this.epoch &&
        this.same(expected) &&
        this.snapshot.unresolved
      ) {
        this.markUnknown(expected);
        this.publish({ error: "timeout", checking: false, listing: false });
      }
    }, this.waitMs);
    void Promise.resolve()
      .then(() => {
        if (!this.same(expected)) {
          if (admission && this.snapshot.kind !== "inspect") {
            this.stopProtectionWatch();
            this.protection.unsent(this.owner, expected.operationId);
          }
          return undefined;
        }
        return call();
      })
      .then((raw) => {
        clearTimeout(timer);
        if (raw !== undefined) this.accept(raw, expected, epoch);
        else if (
          epoch === this.epoch &&
          this.same(expected) &&
          this.snapshot.unresolved
        ) {
          this.markUnknown(expected);
          this.publish({
            error: "invalidResponse",
            checking: false,
            listing: false,
          });
        }
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        if (
          epoch !== this.epoch ||
          !this.same(expected) ||
          !this.snapshot.unresolved
        )
          return;
        // A status error cannot prove anything about the original dispatch.
        const failure = sessionToolChangeRejection(error);
        const released =
          admission && failure?.notDispatched === true && this.settle(expected);
        if (!released) this.markUnknown(expected);
        this.publish({
          error: sessionToolChangeFailure(error) ?? "unknown",
          checking: false,
          listing: false,
          unresolved: !released,
        });
      });
  }
  start(change: SessionToolChange): boolean {
    if (
      this.snapshot.unresolved ||
      this.snapshot.checking ||
      this.snapshot.listing ||
      this.blockedCode ||
      !validSessionToolChange(change) ||
      (change.kind === "remove" &&
        (!this.snapshot.itemsRead ||
          !this.snapshot.items.some(
            (item) => item.itemRef === change.itemRef && item.canRemove,
          )))
    )
      return false;
    const operationId = this.uuid();
    if (
      !validSessionToolsOperationId(operationId) ||
      (change.kind !== "inspect" &&
        !this.protection.claim(this.owner, operationId))
    )
      return false;
    const expected = { ...this.target, operationId };
    this.request = expected;
    this.publish({
      operation: null,
      kind: change.kind,
      checking: true,
      listing: change.kind === "inspect",
      itemsRead: change.kind === "inspect" ? false : this.snapshot.itemsRead,
      unresolved: true,
      recovered: false,
      error: null,
    });
    this.stopProtectionWatch();
    if (change.kind !== "inspect")
      this.stopGuard = this.protection.subscribe(() => {
        if (
          !this.same(expected) ||
          !this.snapshot.unresolved ||
          this.protection.has(this.owner, expected.operationId)
        )
          return;
        this.stopProtectionWatch();
        ++this.epoch;
        this.publish({
          checking: false,
          unresolved: false,
          recovered: true,
          itemsRead: false,
          error: null,
        });
      });
    // Snapshot the user's exact input. Subsequent edits cannot change the dispatch.
    const input = { ...change };
    this.observe(expected, () => this.port.start(expected, input), true);
    return true;
  }
  check(): boolean {
    const expected = this.request;
    if (
      !expected ||
      !this.isCurrent() ||
      !this.snapshot.unresolved ||
      this.snapshot.checking
    )
      return false;
    this.publish({ checking: true, error: null });
    this.observe(expected, () => this.port.status(expected));
    return true;
  }
  list(): boolean {
    return this.start({ kind: "inspect" });
  }
}
const controllers = new WeakMap<ThreadState, SessionToolChangeController>();
export function getSessionToolChangeController(
  owner: ThreadState,
  current: () => ThreadState | undefined,
): SessionToolChangeController {
  const old = controllers.get(owner);
  if (old?.matchesOwner(owner)) {
    old.refreshCurrent(current);
    return old;
  }
  old?.retireOwner();
  const next = new SessionToolChangeController(owner, current);
  controllers.set(owner, next);
  return next;
}
