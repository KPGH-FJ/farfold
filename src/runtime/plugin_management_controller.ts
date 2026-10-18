import type { InventoryOwner } from "./extension_inventory_controller";
import {
  validInventoryDirectory,
  validInventoryId,
} from "./extension_inventory_types";
import {
  pluginManagementPort,
  type PluginManagementPort,
} from "./plugin_management";
import {
  parsePluginCancellation,
  parsePluginOperation,
  pluginFailure,
  type PluginCatalog,
  type PluginCode,
  type PluginItem,
  type PluginOperation,
  type PluginRequest,
  type PluginReview,
  type PluginSourceCatalog,
  type PluginSourceItem,
} from "./plugin_management_types";

export interface PluginResult {
  readonly owner: InventoryOwner;
  readonly request: PluginRequest;
  readonly catalog: PluginCatalog;
  readonly stale: boolean;
}
export interface PluginSourceResult {
  readonly owner: InventoryOwner;
  readonly request: PluginRequest;
  readonly catalog: PluginSourceCatalog;
  readonly stale: boolean;
}
export interface PluginView {
  request: PluginRequest | null;
  operation: PluginOperation | null;
  originalOperation: PluginOperation | null;
  result: PluginResult | null;
  sourceResult: PluginSourceResult | null;
  review: PluginReview | null;
  unresolved: boolean;
  checking: boolean;
  cancelRequested: boolean;
  reviewRetired: boolean;
  trackingReleased: boolean;
  error: PluginCode | null;
}
const EMPTY: PluginView = Object.freeze({
  request: null,
  operation: null,
  originalOperation: null,
  result: null,
  sourceResult: null,
  review: null,
  unresolved: false,
  checking: false,
  cancelRequested: false,
  reviewRetired: false,
  trackingReleased: false,
  error: null,
});
interface Flight {
  owner: InventoryOwner;
  view: PluginView;
  retired: boolean;
  dispatched: boolean;
  epoch: number;
  lost: boolean;
  consumed: boolean;
  confirmation: PluginRequest | null;
}
function freezeItem(item: PluginItem): PluginItem {
  return Object.freeze({
    ...item,
    install: Object.freeze({ ...item.install }),
    remove: Object.freeze({ ...item.remove }),
  });
}
/** Same finite review/dispatch/readback lifecycle as shared extension management.
 * Memory only; closing a view never proves an owned process stopped. */
export class PluginManagementController {
  private entries = new Map<string, Flight>();
  private listeners = new Set<() => void>();
  constructor(
    private port: PluginManagementPort = pluginManagementPort,
    private waitMs = 10000,
    private uuid: () => string = () => crypto.randomUUID(),
    private now = () => Date.now(),
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  get = (agentId: string): PluginView =>
    this.entries.get(agentId)?.view ?? EMPTY;
  private attached(f: Flight) {
    return this.entries.get(f.owner.agentId) === f;
  }
  private current(f: Flight) {
    return this.attached(f) && !f.retired && f.owner.current();
  }
  private publish(f: Flight, patch: Partial<PluginView>) {
    if (!this.attached(f)) return;
    f.view = { ...f.view, ...patch };
    for (const fn of [...this.listeners]) fn();
  }
  private stale(f: Flight) {
    if (f.view.result && !f.view.result.stale)
      this.publish(f, { result: { ...f.view.result, stale: true } });
  }
  private staleSources(f: Flight) {
    if (f.view.sourceResult && !f.view.sourceResult.stale)
      this.publish(f, {
        sourceResult: { ...f.view.sourceResult, stale: true },
      });
  }
  private replace(
    owner: InventoryOwner,
    request: PluginRequest,
    old?: Flight,
  ): Flight | null {
    if (old?.view.unresolved) return null;
    if (!old && this.entries.size >= 64) {
      const free = [...this.entries].find(([, f]) => !f.view.unresolved);
      if (!free) return null;
      this.retire(free[1].owner);
      this.entries.delete(free[0]);
    }
    const priorResult = old?.view.result ?? null;
    const priorSources = old?.view.sourceResult ?? null;
    if (old) this.retire(old.owner);
    const f: Flight = {
      owner,
      view: {
        ...EMPTY,
        request: Object.freeze(request),
        originalOperation: old?.view.originalOperation ?? null,
        sourceResult:
          request.action !== "sources" && priorSources?.owner === owner
            ? priorSources
            : (old?.view.sourceResult ?? null),
        result:
          request.action === "inspect" && priorResult?.owner === owner
            ? priorResult
            : (old?.view.result ?? null),
        unresolved: true,
      },
      retired: false,
      dispatched: false,
      epoch: 0,
      lost: false,
      consumed: false,
      confirmation: old?.confirmation ?? null,
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    return f;
  }
  private accept(f: Flight, raw: unknown) {
    if (!this.attached(f) || !f.view.unresolved || !f.view.request) return;
    const op = parsePluginOperation(raw, f.view.request),
      old = f.view.operation;
    if (old?.writeDispatched && !op.writeDispatched) return;
    if (
      old &&
      !["none", "unknown"].includes(old.writeAck) &&
      old.writeAck !== op.writeAck
    )
      return;
    if (
      !op.settled &&
      ((old?.state === "pendingCleanup" && op.state !== "pendingCleanup") ||
        (f.view.cancelRequested && op.state === "running"))
    )
      return;
    let result = f.view.result;
    let sourceResult = f.view.sourceResult;
    if (op.sources && this.current(f) && !f.view.cancelRequested) {
      const items = op.sources.items.map((item) =>
        Object.freeze({
          ...item,
          query: Object.freeze({ ...item.query }),
        }),
      );
      const catalog = Object.freeze({ ...op.sources, items });
      Object.freeze(items);
      sourceResult = Object.freeze({
        owner: f.owner,
        request: f.view.request,
        catalog,
        stale: false,
      });
    }
    if (op.catalog && this.current(f) && !f.view.cancelRequested) {
      const c = { ...op.catalog, items: op.catalog.items.map(freezeItem) };
      Object.freeze(c.items);
      Object.freeze(c);
      result = Object.freeze({
        owner: f.owner,
        request: f.view.request,
        catalog: c,
        stale: false,
      });
    }
    let review: PluginReview | null = null;
    if (
      op.review &&
      this.current(f) &&
      !f.consumed &&
      !f.view.cancelRequested &&
      this.now() < op.review.observedAtMs + op.review.validForMs
    ) {
      if (
        f.view.review &&
        JSON.stringify(f.view.review) !== JSON.stringify(op.review)
      )
        throw { code: "invalidOutput" };
      review = Object.freeze({
        ...op.review,
        target: freezeItem(op.review.target),
      });
    }
    const wrote =
      ["install", "remove"].includes(f.view.request.action) &&
      op.writeDispatched;
    // Keep one paired receipt for the latest actual write. A new read or an
    // undispatched confirmation cannot replace its facts or readback target.
    if (wrote) f.confirmation = f.view.request;
    this.publish(f, {
      operation: op,
      originalOperation: wrote ? op : f.view.originalOperation,
      result,
      sourceResult,
      review,
      unresolved: !op.settled,
      checking: false,
      reviewRetired: !!op.review && !review,
      error: op.code,
    });
    if (op.writeDispatched) this.stale(f);
  }
  private observe(
    f: Flight,
    call: () => Promise<unknown>,
    cancellation = false,
    releaseAbsent = false,
    freshConfirmation = false,
  ) {
    const epoch = ++f.epoch;
    const timer = setTimeout(() => {
      if (this.attached(f) && f.view.unresolved) {
        f.lost = true;
        this.publish(f, { checking: false, error: "timedOut" });
      }
    }, this.waitMs);
    void Promise.resolve()
      .then(call)
      .then((raw) => {
        clearTimeout(timer);
        if (!this.attached(f) || !f.view.unresolved || !f.view.request) return;
        if (!cancellation) this.accept(f, raw);
        else {
          const op = parsePluginCancellation(raw, f.view.request);
          if (op) this.accept(f, op);
          else if (releaseAbsent)
            this.publish(f, {
              unresolved: false,
              checking: false,
              trackingReleased: true,
              error: "unknownRequest",
              review: null,
              reviewRetired: true,
            });
          else this.publish(f, { checking: false });
        }
      })
      .catch((reason) => {
        clearTimeout(timer);
        if (!this.attached(f) || !f.view.unresolved || f.epoch !== epoch)
          return;
        const code = pluginFailure(reason) ?? "unavailable";
        // These explicit fresh-confirm rejections precede admission. A lost reply,
        // status failure or timeout does not establish that nothing was written.
        if (
          freshConfirmation &&
          !f.lost &&
          !f.view.operation &&
          ["install", "remove"].includes(f.view.request?.action ?? "") &&
          (code === "reviewExpired" || code === "reviewConsumed")
        )
          this.publish(f, {
            unresolved: false,
            review: null,
            reviewRetired: true,
            checking: false,
            error: code,
          });
        else this.publish(f, { checking: false, error: code });
      });
  }
  isCurrentResult(owner: InventoryOwner, result: PluginResult) {
    return (
      owner.current() &&
      result.owner === owner &&
      !result.stale &&
      result.request.sourceRequestId ===
        this.get(owner.agentId).sourceResult?.request.requestId &&
      this.get(owner.agentId).result === result
    );
  }
  isCurrentSources(owner: InventoryOwner, result: PluginSourceResult) {
    return (
      owner.current() &&
      result.owner === owner &&
      !result.stale &&
      this.get(owner.agentId).sourceResult === result
    );
  }
  begin(owner: InventoryOwner, cwd: string, selectionId: string): boolean {
    if (
      !owner.current() ||
      !validInventoryDirectory(cwd) ||
      !validInventoryId(selectionId)
    )
      return false;
    const f = this.replace(
      owner,
      {
        agentId: owner.agentId,
        requestId: this.uuid(),
        cwd,
        action: "sources",
      },
      this.entries.get(owner.agentId),
    );
    if (!f) return false;
    this.stale(f);
    this.staleSources(f);
    this.observe(f, async () => {
      if (!this.current(f) || f.view.cancelRequested) {
        this.publish(f, { unresolved: false, error: "selectionChanged" });
        return;
      }
      f.dispatched = true;
      return this.port.sources({
        agentId: owner.agentId,
        requestId: f.view.request!.requestId,
        cwd,
        selectionId,
      });
    });
    return true;
  }
  inventory(
    owner: InventoryOwner,
    source: PluginSourceResult,
    item: PluginSourceItem,
  ): boolean {
    if (
      !this.isCurrentSources(owner, source) ||
      !source.catalog.items.includes(item) ||
      item.query.availability !== "available"
    )
      return false;
    const f = this.replace(
      owner,
      {
        agentId: owner.agentId,
        requestId: this.uuid(),
        cwd: source.request.cwd,
        action: "inventory",
        sourceRequestId: source.request.requestId,
        sourceId: item.id,
        querySource: item,
      },
      this.entries.get(owner.agentId),
    );
    if (!f) return false;
    this.observe(f, async () => {
      if (
        !this.current(f) ||
        f.view.cancelRequested ||
        !this.isCurrentSources(owner, source)
      ) {
        this.publish(f, { unresolved: false, error: "selectionChanged" });
        return;
      }
      f.dispatched = true;
      return this.port.inventory({
        agentId: owner.agentId,
        requestId: f.view.request!.requestId,
        sourceRequestId: source.request.requestId,
        sourceId: item.id,
      });
    });
    return true;
  }
  inspect(
    owner: InventoryOwner,
    result: PluginResult,
    item: PluginItem,
    install: boolean,
  ): boolean {
    if (
      !this.isCurrentResult(owner, result) ||
      !result.catalog.items.includes(item) ||
      (install ? item.install : item.remove).availability !== "available"
    )
      return false;
    const target = freezeItem(item);
    const f = this.replace(
      owner,
      {
        agentId: owner.agentId,
        requestId: this.uuid(),
        cwd: result.request.cwd,
        action: "inspect",
        target,
        install,
      },
      this.entries.get(owner.agentId),
    );
    if (!f) return false;
    this.observe(f, async () => {
      if (
        !this.current(f) ||
        f.view.cancelRequested ||
        !this.isCurrentResult(owner, result)
      ) {
        this.publish(f, {
          unresolved: false,
          reviewRetired: true,
          error: "selectionChanged",
        });
        return;
      }
      f.dispatched = true;
      return this.port.inspect({
        agentId: owner.agentId,
        requestId: f.view.request!.requestId,
        inventoryRequestId: result.request.requestId,
        itemId: item.id,
        install,
      });
    });
    return true;
  }
  canConfirm(owner: InventoryOwner, review: PluginReview): boolean {
    const f = this.entries.get(owner.agentId);
    return (
      !!f &&
      f.owner === owner &&
      this.current(f) &&
      !f.view.unresolved &&
      !f.consumed &&
      !f.view.cancelRequested &&
      f.view.review === review &&
      f.view.operation?.state === "ready" &&
      this.now() < review.observedAtMs + review.validForMs
    );
  }
  confirm(owner: InventoryOwner, review: PluginReview): boolean {
    if (!this.canConfirm(owner, review)) return false;
    const old = this.entries.get(owner.agentId)!;
    old.consumed = true;
    const request: PluginRequest = Object.freeze({
      agentId: owner.agentId,
      requestId: this.uuid(),
      cwd: review.cwd,
      action: review.install ? "install" : "remove",
      target: freezeItem(review.target),
      install: review.install,
    });
    const f: Flight = {
      ...old,
      view: {
        ...EMPTY,
        request,
        originalOperation: old.view.originalOperation,
        sourceResult: old.view.sourceResult,
        result: old.view.result,
        unresolved: true,
        reviewRetired: true,
      },
      dispatched: false,
      epoch: 0,
      lost: false,
      confirmation: old.confirmation,
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    this.observe(
      f,
      async () => {
        if (!this.current(f) || f.view.cancelRequested) {
          this.publish(f, { unresolved: false, error: "selectionChanged" });
          return;
        }
        f.dispatched = true;
        this.stale(f);
        return this.port.confirm({
          agentId: owner.agentId,
          requestId: request.requestId,
          reviewId: review.reviewId,
        });
      },
      false,
      false,
      true,
    );
    return true;
  }
  check(agentId: string, requestId: string) {
    const f = this.entries.get(agentId);
    if (
      !f ||
      f.view.request?.requestId !== requestId ||
      !f.view.unresolved ||
      f.view.checking
    )
      return;
    this.publish(f, { checking: true });
    this.observe(f, () => this.port.status({ agentId, requestId }));
  }
  cancel(agentId: string, requestId: string, explicit = true) {
    const f = this.entries.get(agentId);
    if (!f || f.view.request?.requestId !== requestId) return;
    const releaseAbsent = explicit && f.view.error === "unknownRequest";
    f.retired = true;
    this.publish(f, {
      review: null,
      reviewRetired: true,
      cancelRequested: true,
    });
    if (f.dispatched && f.view.unresolved)
      this.observe(
        f,
        () => this.port.cancel({ agentId, requestId }),
        true,
        releaseAbsent,
      );
    else if (f.dispatched && f.view.request.action === "inspect")
      void this.port.cancel({ agentId, requestId }).catch(() => {});
  }
  retire(owner: InventoryOwner) {
    const f = this.entries.get(owner.agentId);
    if (!f || f.owner !== owner || f.view.cancelRequested) return;
    this.stale(f);
    this.staleSources(f);
    if (f.view.request)
      this.cancel(owner.agentId, f.view.request.requestId, false);
  }
  retireInspection(owner: InventoryOwner) {
    const f = this.entries.get(owner.agentId);
    if (
      f?.owner === owner &&
      f.view.request?.action === "inspect" &&
      !f.retired
    )
      this.cancel(owner.agentId, f.view.request.requestId, false);
  }
  retireSourceSelection(owner: InventoryOwner) {
    const f = this.entries.get(owner.agentId);
    if (!f || f.owner !== owner) return;
    this.stale(f);
    this.retireInspection(owner);
  }
  recheck(agentId: string, requestId: string): boolean {
    const old = this.entries.get(agentId);
    const originalOperation =
      old?.view.originalOperation ?? old?.view.operation;
    if (
      !old ||
      old.view.request?.requestId !== requestId ||
      old.view.unresolved ||
      !old.confirmation ||
      !originalOperation?.settled ||
      !originalOperation?.writeDispatched
    )
      return false;
    const request: PluginRequest = Object.freeze({
      ...old.confirmation,
      action: "recheck",
      requestId: this.uuid(),
      operationId: old.confirmation.requestId,
    });
    const f: Flight = {
      ...old,
      view: {
        ...EMPTY,
        request,
        result: old.view.result,
        sourceResult: old.view.sourceResult,
        unresolved: true,
        originalOperation,
      },
      retired: true,
      dispatched: false,
      epoch: 0,
    };
    this.entries.set(agentId, f);
    this.publish(f, {});
    this.observe(f, async () => {
      if (!this.attached(f) || f.view.cancelRequested) {
        this.publish(f, { unresolved: false, error: "cancelled" });
        return;
      }
      f.dispatched = true;
      return this.port.recheck({
        agentId,
        requestId: request.requestId,
        operationId: request.operationId!,
      });
    });
    return true;
  }
}
export const pluginManagement = new PluginManagementController();
