import { configChangeBusy } from "./protected_config";
import type { ThreadState } from "./session_types";
import { sessionToolsPort, type SessionToolsPort } from "./session_tools";
import {
  parseSessionToolsOperation,
  sessionToolInventoryCapability,
  sessionToolsFailure,
  validSessionToolsOperationId,
  type SessionToolsCode,
  type SessionToolsOperation,
  type SessionToolsReport,
  type SessionToolsRequest,
  type SessionToolsTarget,
  type SessionToolConfigurationReport,
} from "./session_tools_types";

export interface SessionToolsSnapshot {
  phase: "idle" | "loading" | "pending" | "ready" | "error";
  operationId: string | null;
  operation: SessionToolsOperation | null;
  lastReport: { value: SessionToolsReport; extensionName?: string } | null;
  lastConfiguration: SessionToolConfigurationReport | null;
  error: SessionToolsCode | null;
  checking: boolean;
  unresolved: boolean;
}
const EMPTY: SessionToolsSnapshot = Object.freeze({
  phase: "idle",
  operationId: null,
  operation: null,
  lastReport: null,
  lastConfiguration: null,
  error: null,
  checking: false,
  unresolved: false,
});
const sourceOf = (s: ThreadState | null | undefined) =>
  JSON.stringify([
    s?.serviceContext ?? null,
    s?.service?.id ?? null,
    s?.service?.fingerprint ?? null,
  ]);
const validOwnerPart = (v: unknown) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 8192 &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(v);

/** One read-only owner. Closing a panel only removes its subscription; pending
 * native work and its operation ID stay available to an explicit status check. */
export class SessionToolsController {
  private snapshot: SessionToolsSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private retired = false;
  private unavailable = false;
  private configurationUnavailable = false;
  private epoch = 0;
  private request: SessionToolsRequest | null = null;
  private readonly target: SessionToolsTarget;
  private readonly key: string;
  private readonly source: string;
  constructor(
    private readonly owner: ThreadState | null,
    private current: () => ThreadState | undefined,
    private readonly port: SessionToolsPort = sessionToolsPort,
    private readonly waitMs = 12000,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.target = {
      agentId: owner?.agentId ?? "",
      cwd: owner?.cwd ?? "",
      sessionId: owner?.nativeSessionId ?? "",
      connectionId: owner?.connectionId ?? "",
    };
    this.key = owner?.key ?? "";
    this.source = sourceOf(owner);
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;
  private publish(update: Partial<SessionToolsSnapshot>) {
    if (this.retired) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of [...this.listeners]) listener();
  }
  matchesOwner(s: ThreadState | null | undefined): boolean {
    return Boolean(
      !this.retired &&
      s &&
      s === this.owner &&
      validOwnerPart(this.key) &&
      s.key === this.key &&
      s.agentId === this.target.agentId &&
      s.cwd === this.target.cwd &&
      s.nativeSessionId === this.target.sessionId &&
      s.connectionId === this.target.connectionId &&
      sourceOf(s) === this.source &&
      Object.values(this.target).every(validOwnerPart),
    );
  }
  readonly isCurrent = () => this.matchesOwner(this.current());
  get requestedExtension(): string | undefined {
    return this.request?.extensionName;
  }
  get requestedConfiguration(): boolean {
    return this.request?.configuration === true;
  }
  get blockedCode(): SessionToolsCode | null {
    return this.blockedFor();
  }
  blockedFor(configuration?: true): SessionToolsCode | null {
    if (!this.isCurrent()) return "changed";
    const capability = sessionToolInventoryCapability(
      this.owner?.sessionToolInventory,
    );
    if (
      !capability ||
      (configuration
        ? this.configurationUnavailable || !capability.configuration
        : this.unavailable || capability.toolsUnavailable)
    )
      return "unavailable";
    return configChangeBusy(this.owner!) ? "busy" : null;
  }
  /** Ownership replacement, never panel dismissal. Does not cancel the Agent. */
  retireOwner() {
    this.retired = true;
    this.listeners.clear();
  }
  refreshCurrent(current: () => ThreadState | undefined) {
    this.current = current;
  }
  private sameRequest(expected: SessionToolsRequest) {
    return this.isCurrent() && this.request === expected;
  }
  private canReadExtension(name?: string): boolean {
    return (
      name === undefined ||
      (sessionToolInventoryCapability(
        this.owner?.sessionToolInventory,
      )?.extensions?.includes(name) ??
        false)
    );
  }
  private accept(raw: unknown, expected: SessionToolsRequest, epoch: number) {
    if (!this.sameRequest(expected) || !this.snapshot.unresolved) return;
    let operation: SessionToolsOperation;
    try {
      operation = parseSessionToolsOperation(raw, expected);
    } catch {
      if (epoch === this.epoch)
        this.publish({
          phase: "error",
          error: "invalidResponse",
          checking: false,
        });
      return;
    }
    if (!operation.settled && epoch !== this.epoch) return;
    if (operation.settled && operation.error?.code === "unavailable")
      this.markUnavailable(expected);
    const configuration = operation.configurationReport;
    this.publish({
      phase:
        operation.state === "ready"
          ? "ready"
          : operation.state === "pending"
            ? "pending"
            : "error",
      operation,
      lastReport:
        operation.report &&
        (operation.extensionName === undefined ||
          operation.report.reportedItemCount > 0)
          ? { value: operation.report, extensionName: operation.extensionName }
          : this.snapshot.lastReport,
      lastConfiguration:
        configuration && configuration.reportedItemCount > 0
          ? configuration
          : this.snapshot.lastConfiguration,
      error: operation.error?.code ?? null,
      unresolved: !operation.settled,
      checking: false,
    });
  }
  private markUnavailable(expected: SessionToolsRequest) {
    if (expected.configuration) this.configurationUnavailable = true;
    else this.unavailable = true;
  }
  private observe(expected: SessionToolsRequest, call: () => Promise<unknown>) {
    const epoch = ++this.epoch;
    const timer = setTimeout(() => {
      if (
        epoch === this.epoch &&
        this.sameRequest(expected) &&
        this.snapshot.unresolved
      )
        this.publish({ phase: "error", error: "timeout", checking: false });
    }, this.waitMs);
    void Promise.resolve()
      .then(() => {
        if (!this.sameRequest(expected)) return;
        return call();
      })
      .then((raw) => {
        clearTimeout(timer);
        if (raw !== undefined) this.accept(raw, expected, epoch);
        else if (this.sameRequest(expected) && this.snapshot.unresolved)
          this.publish({
            phase: "error",
            error: "invalidResponse",
            checking: false,
          });
      })
      .catch((raw) => {
        clearTimeout(timer);
        if (
          epoch !== this.epoch ||
          !this.sameRequest(expected) ||
          !this.snapshot.unresolved
        )
          return;
        const failure = sessionToolsFailure(raw),
          code = failure?.code ?? "queryFailed";
        // These are native pre-admission/obsolete-slot refusals. A local transport
        // error cannot prove the read was not admitted; keep its known ID for status.
        const released =
          failure &&
          ["changed", "busy", "unavailable", "readLimit"].includes(code);
        if (failure?.code === "unavailable") this.markUnavailable(expected);
        this.publish({
          phase: "error",
          error: code,
          checking: false,
          unresolved: !released,
        });
      });
  }
  read(extensionName?: string, configuration?: true): boolean {
    if (
      this.snapshot.unresolved ||
      this.snapshot.checking ||
      this.blockedFor(configuration) ||
      (configuration && extensionName !== undefined)
    )
      return false;
    if (!this.canReadExtension(extensionName)) return false;
    const operationId = this.uuid();
    if (!validSessionToolsOperationId(operationId)) {
      this.publish({ phase: "error", error: "invalidResponse" });
      return false;
    }
    const expected = {
      ...this.target,
      operationId,
      ...(extensionName === undefined ? {} : { extensionName }),
      ...(configuration ? { configuration } : {}),
    };
    this.request = expected;
    this.publish({
      phase: "loading",
      operationId,
      operation: null,
      error: null,
      checking: true,
      unresolved: true,
    });
    this.observe(expected, () => {
      const code = this.blockedFor(configuration);
      if (code || !this.canReadExtension(extensionName)) {
        this.publish({
          phase: "error",
          error: code ?? "changed",
          checking: false,
          unresolved: false,
        });
        return Promise.resolve(undefined);
      }
      return this.port.read(expected);
    });
    return true;
  }
  check(): boolean {
    const expected = this.request;
    if (
      !expected ||
      !this.snapshot.unresolved ||
      this.snapshot.checking ||
      !this.isCurrent()
    )
      return false;
    this.publish({ checking: true });
    this.observe(expected, () => this.port.status(expected));
    return true;
  }
}

const controllers = new WeakMap<ThreadState, SessionToolsController>();
/** Same object and exact live owner reuse one pending read across panel mounts. */
export function getSessionToolsController(
  owner: ThreadState | null,
  current: () => ThreadState | undefined,
): SessionToolsController {
  if (!owner) return new SessionToolsController(null, current);
  const old = controllers.get(owner);
  if (old?.matchesOwner(owner)) {
    old.refreshCurrent(current);
    return old;
  }
  old?.retireOwner();
  const controller = new SessionToolsController(owner, current);
  controllers.set(owner, controller);
  return controller;
}
