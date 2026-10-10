import { inventoryPort, type InventoryPort } from "./extension_inventory";
import {
  extensionFailure,
  parseInventoryCancellation,
  parseInventoryOperation,
  validInventoryDirectory,
  validInventoryId,
  type ExtensionCode,
  type InventoryOperation,
  type InventoryRequest,
  type InventorySnapshot,
  type InventoryKind,
} from "./extension_inventory_types";
export interface InventoryOwner {
  readonly agentId: string;
  readonly token: object;
  current(): boolean;
}
export interface InventoryResult {
  readonly request: InventoryRequest;
  readonly owner: InventoryOwner;
  readonly cwd: string;
  readonly snapshot: InventorySnapshot;
  readonly stale: boolean;
}
export interface InventoryView {
  request: InventoryRequest | null;
  selectionId: string | null;
  operation: InventoryOperation | null;
  result: InventoryResult | null;
  results: Partial<Record<InventoryKind, InventoryResult>>;
  stale: boolean;
  unresolved: boolean;
  checking: boolean;
  trackingReleased: boolean;
  cancellationRequested: boolean;
  error: ExtensionCode | null;
}
const EMPTY: InventoryView = Object.freeze({
  request: null,
  selectionId: null,
  operation: null,
  result: null,
  results: Object.freeze({}),
  stale: false,
  unresolved: false,
  checking: false,
  trackingReleased: false,
  cancellationRequested: false,
  error: null,
});
interface Flight {
  owner: InventoryOwner;
  view: InventoryView;
  retired: boolean;
  dispatched: boolean;
  observationLost: boolean;
  checkEpoch: number;
  managementRevoked: boolean;
}
/** Memory-only bounded slots survive a closed panel until actual terminal evidence. */
export class ExtensionInventoryController {
  private entries = new Map<string, Flight>();
  private listeners = new Set<() => void>();
  constructor(
    private port: InventoryPort = inventoryPort,
    private observationMs = 10000,
    private uuid = () => crypto.randomUUID(),
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (agentId: string): InventoryView =>
    this.entries.get(agentId)?.view ?? EMPTY;
  private publish(f: Flight, update: Partial<InventoryView>) {
    if (this.entries.get(f.owner.agentId) !== f) return;
    f.view = { ...f.view, ...update };
    for (const fn of [...this.listeners]) fn();
  }
  private owns(f: Flight) {
    return !f.retired && f.owner.current();
  }
  private accept(f: Flight, value: unknown) {
    if (
      !f.view.request ||
      this.entries.get(f.owner.agentId) !== f ||
      !f.view.unresolved
    )
      return;
    const op = parseInventoryOperation(value, f.view.request);
    // An old running read cannot roll a later cancellation/cleanup observation back.
    if (
      !op.settled &&
      f.view.operation?.state === "pendingCleanup" &&
      op.state !== "pendingCleanup"
    )
      return;
    if (!op.settled && f.view.cancellationRequested && op.state === "running")
      return;
    const display =
      op.state === "ready" &&
      op.snapshot &&
      this.owns(f) &&
      !f.view.cancellationRequested;
    const result = display
      ? {
          request: f.view.request,
          owner: f.owner,
          cwd: op.cwd,
          snapshot: op.snapshot!,
          stale: false,
        }
      : null;
    this.publish(f, {
      operation: op,
      unresolved: !op.settled,
      checking: false,
      error: op.code ?? null,
      ...(display
        ? {
            result,
            results: { ...f.view.results, [op.kind]: result! },
            stale: false,
          }
        : {}),
    });
  }
  private observe(
    f: Flight,
    promise: Promise<unknown>,
    success: (value: unknown) => void,
    failure: (reason: unknown) => void,
  ) {
    const timer = setTimeout(() => {
      if (this.entries.get(f.owner.agentId) === f && f.view.unresolved) {
        f.observationLost = true;
        this.publish(f, {
          checking: false,
          error: "timedOut",
          unresolved: true,
        });
      }
    }, this.observationMs);
    // Keep observing the original promise; timeout never starts another query.
    void promise.then(
      (value) => {
        clearTimeout(timer);
        try {
          success(value);
        } catch (reason) {
          failure(reason);
        }
      },
      (reason) => {
        clearTimeout(timer);
        failure(reason);
      },
    );
  }
  begin(
    owner: InventoryOwner,
    cwd: string,
    selectionId: string,
    kind: InventoryKind = "mcp",
  ): boolean {
    const previous = this.entries.get(owner.agentId);
    if (
      !owner.current() ||
      !validInventoryId(selectionId) ||
      !validInventoryDirectory(cwd) ||
      previous?.view.unresolved
    )
      return false;
    if (!previous && this.entries.size >= 64) {
      const removable = [...this.entries].find(([, f]) => !f.view.unresolved);
      if (!removable) return false;
      this.retire(removable[1].owner);
      this.entries.delete(removable[0]);
    }
    if (previous) this.revokeManagement(previous);
    const request = Object.freeze({
      agentId: owner.agentId,
      cwd,
      requestId: this.uuid(),
      kind,
    });
    const results = Object.fromEntries(
      Object.entries(previous?.view.results ?? {}).map(([key, value]) => [
        key,
        { ...value, stale: true },
      ]),
    );
    const f: Flight = {
      owner,
      retired: false,
      dispatched: false,
      observationLost: false,
      checkEpoch: 0,
      managementRevoked: false,
      view: {
        ...EMPTY,
        request,
        selectionId,
        result: results[kind] ?? null,
        results,
        stale: !!results[kind],
        unresolved: true,
      },
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    // Subscribers may synchronously close/change the owner.
    if (!this.owns(f)) {
      this.publish(f, { unresolved: false, error: "selectionChanged" });
      return false;
    }
    f.dispatched = true;
    this.observe(
      f,
      Promise.resolve().then(() => {
        if (!this.owns(f) || f.view.cancellationRequested)
          throw { code: "cancelled" };
        return this.port.read({ ...request, selectionId });
      }),
      (value) => this.accept(f, value),
      (reason) => {
        if (!f.view.unresolved) return;
        const code = extensionFailure(reason);
        // Only the fresh read's precise pre-admission failures prove no worker was started.
        const notStarted =
          !f.observationLost &&
          !f.view.operation &&
          (code === "busy" ||
            code === "cwdUnavailable" ||
            code === "invalidRequest" ||
            code === "cancelled" ||
            code === "selectionChanged");
        this.publish(f, {
          error: code ?? "unavailable",
          unresolved: !notStarted,
          checking: false,
        });
      },
    );
    return true;
  }
  check(agentId: string, requestId: string): void {
    const f = this.entries.get(agentId);
    if (
      !f ||
      f.view.request?.requestId !== requestId ||
      !f.view.unresolved ||
      f.view.checking
    )
      return;
    const epoch = ++f.checkEpoch;
    this.publish(f, { checking: true });
    if (this.entries.get(agentId) !== f || !f.view.unresolved) return;
    this.observe(
      f,
      Promise.resolve().then(() => this.port.status(f.view.request!)),
      (value) => {
        if (epoch !== f.checkEpoch) return;
        this.accept(f, value);
      },
      (reason) => {
        if (epoch === f.checkEpoch && f.view.unresolved)
          this.publish(f, {
            checking: false,
            error: extensionFailure(reason) ?? "unavailable",
          });
      },
    );
  }
  cancel(agentId: string, requestId: string, explicit = true): void {
    const f = this.entries.get(agentId);
    if (!f || f.view.request?.requestId !== requestId || !f.view.unresolved)
      return;
    const releaseAbsent = explicit && f.view.error === "unknownRequest";
    const epoch = ++f.checkEpoch;
    this.publish(f, { cancellationRequested: true, stale: !!f.view.result });
    if (!f.dispatched) return;
    this.observe(
      f,
      Promise.resolve().then(() => this.port.cancel(f.view.request!)),
      (value) => {
        const operation = parseInventoryCancellation(value, f.view.request!);
        if (operation) this.accept(f, operation);
        else if (releaseAbsent && f.view.unresolved) {
          // Exact absent tombstone after explicit unknown-status recovery fences the
          // old ID. Retire tracking only: no result, successful cancellation or replay.
          f.retired = true;
          this.publish(f, {
            unresolved: false,
            checking: false,
            trackingReleased: true,
            error: "unknownRequest",
            stale: !!f.view.result,
          });
        }
        // Ordinary early null, including automatic close, remains uncertain.
      },
      (reason) => {
        if (epoch === f.checkEpoch && f.view.unresolved)
          this.publish(f, {
            checking: false,
            error: extensionFailure(reason) ?? "unavailable",
          });
      },
    );
  }
  retire(owner: InventoryOwner): void {
    const f = this.entries.get(owner.agentId);
    if (!f || f.owner !== owner || f.retired) return;
    f.retired = true;
    this.publish(f, {
      stale: !!f.view.result,
      results: Object.fromEntries(
        Object.entries(f.view.results).map(([key, value]) => [
          key,
          { ...value, stale: true },
        ]),
      ),
    });
    if (f.view.request && f.view.unresolved)
      this.cancel(owner.agentId, f.view.request.requestId, false);
    else this.revokeManagement(f);
  }
  private revokeManagement(f: Flight) {
    if (
      f.managementRevoked ||
      f.view.request?.kind !== "skills" ||
      !f.dispatched
    )
      return;
    f.managementRevoked = true;
    const request = f.view.request;
    // Ready reads may retain a private management map. Revoke that exact map,
    // leaving the public report and an independent confirmation untouched.
    void Promise.resolve()
      .then(() => this.port.cancel(request))
      .catch(() => {});
  }
  isCurrentResult(owner: InventoryOwner, result: InventoryResult): boolean {
    const f = this.entries.get(owner.agentId);
    return (
      !!f &&
      this.owns(f) &&
      f.owner === owner &&
      result.owner === owner &&
      f.view.results.skills === result &&
      !f.managementRevoked &&
      !result.stale &&
      !f.view.unresolved
    );
  }
  markStale(result: InventoryResult): void {
    const f = this.entries.get(result.request.agentId);
    if (!f || f.view.results.skills !== result) return;
    this.revokeManagement(f);
    const stale = { ...result, stale: true };
    this.publish(f, {
      results: { ...f.view.results, skills: stale },
      ...(f.view.result === result ? { result: stale, stale: true } : {}),
    });
  }
}
export const extensionInventory = new ExtensionInventoryController();
