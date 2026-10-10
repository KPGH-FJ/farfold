import type {
  InventoryOwner,
  InventoryResult,
} from "./extension_inventory_controller";
import type { SkillInventoryItem } from "./extension_inventory_types";
import {
  skillManagementPort,
  type SkillManagementPort,
} from "./skill_management";
import {
  parseSkillChangeOperation,
  parseSkillChangeCancellation,
  skillChangeFailure,
  type SkillChangeRequest,
  type SkillChangeOperation,
  type SkillChangeReview,
  type SkillChangeCode,
} from "./skill_management_types";

export interface SkillChangeTargetOwner {
  owner: InventoryOwner;
  result: InventoryResult;
  item: SkillInventoryItem;
  current(): boolean;
  changed(): void;
}
export interface SkillManagementView {
  request: SkillChangeRequest | null;
  operation: SkillChangeOperation | null;
  review: SkillChangeReview | null;
  reviewRetired: boolean;
  unresolved: boolean;
  checking: boolean;
  cancelRequested: boolean;
  trackingReleased: boolean;
  admissionRejected: boolean;
  error: SkillChangeCode | null;
}
const EMPTY: SkillManagementView = Object.freeze({
  request: null,
  operation: null,
  review: null,
  reviewRetired: false,
  unresolved: false,
  checking: false,
  cancelRequested: false,
  trackingReleased: false,
  admissionRejected: false,
  error: null,
});
interface Flight {
  target: SkillChangeTargetOwner;
  view: SkillManagementView;
  retired: boolean;
  consumed: boolean;
  dispatched: boolean;
  lost: boolean;
  epoch: number;
  inspection: SkillChangeRequest;
  inspectionRevoked: boolean;
  confirmation: SkillChangeRequest | null;
  reviewDeadline: number | null;
  inheritedWrite: Pick<
    SkillChangeOperation,
    "writeDispatched" | "writeAck"
  > | null;
}
/** One current operation per Agent; public results only, no persistent task ledger. */
export class SkillManagementController {
  private entries = new Map<string, Flight>();
  private listeners = new Set<() => void>();
  constructor(
    private port: SkillManagementPort = skillManagementPort,
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
  get = (agentId: string): SkillManagementView =>
    this.entries.get(agentId)?.view ?? EMPTY;
  private attached(f: Flight) {
    return this.entries.get(f.target.owner.agentId) === f;
  }
  private publish(f: Flight, update: Partial<SkillManagementView>) {
    if (!this.attached(f)) return;
    f.view = { ...f.view, ...update };
    for (const fn of [...this.listeners]) fn();
  }
  private current(f: Flight) {
    return (
      this.attached(f) &&
      !f.retired &&
      f.target.owner.current() &&
      f.target.current()
    );
  }
  private revokeReview(f: Flight) {
    if (f.inspectionRevoked) return;
    f.inspectionRevoked = true;
    void Promise.resolve()
      .then(() =>
        this.port.cancel({
          agentId: f.inspection.agentId,
          requestId: f.inspection.requestId,
        }),
      )
      .catch(() => {});
  }
  private accept(f: Flight, raw: unknown) {
    if (!this.attached(f) || !f.view.unresolved || !f.view.request) return;
    const op = parseSkillChangeOperation(raw, f.view.request),
      old = f.view.operation;
    if (
      f.inheritedWrite &&
      (op.writeDispatched !== f.inheritedWrite.writeDispatched ||
        op.writeAck !== f.inheritedWrite.writeAck)
    )
      throw { code: "invalidOutput" };
    // Concurrent read/status/cancel replies cannot erase already observed write facts.
    if (old?.writeDispatched && !op.writeDispatched) return;
    if (
      old &&
      old.writeAck !== "none" &&
      old.writeAck !== "unknown" &&
      op.writeAck !== old.writeAck
    )
      return;
    if (
      !op.settled &&
      ((old?.state === "pendingCleanup" && op.state !== "pendingCleanup") ||
        (f.view.cancelRequested && op.state === "running"))
    )
      return;
    let rev: SkillChangeReview | null = null;
    if (
      op.review &&
      !f.consumed &&
      !f.inspectionRevoked &&
      this.current(f) &&
      !f.view.cancelRequested
    ) {
      if (
        f.view.review &&
        (f.view.review.reviewId !== op.review.reviewId ||
          JSON.stringify(f.view.review) !== JSON.stringify(op.review))
      )
        throw { code: "invalidOutput" };
      f.reviewDeadline ??= op.review.observedAtMs + op.review.validForMs;
      if (this.now() < f.reviewDeadline) rev = op.review;
    }
    if (op.writeDispatched) f.target.changed();
    this.publish(f, {
      operation: op,
      review: rev,
      reviewRetired: !!op.review && !rev,
      unresolved: !op.settled,
      checking: false,
      error: op.code,
    });
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
        if (f.view.request?.action === "setEnabled") f.target.changed();
        this.publish(f, { checking: false, error: "timedOut" });
      }
    }, this.waitMs);
    void Promise.resolve()
      .then(call)
      .then((raw) => {
        clearTimeout(timer);
        if (!this.attached(f) || !f.view.unresolved || !f.view.request) return;
        if (cancellation) {
          const op = parseSkillChangeCancellation(raw, f.view.request);
          if (op) this.accept(f, op);
          else if (releaseAbsent) {
            f.retired = true;
            this.publish(f, {
              unresolved: false,
              checking: false,
              review: null,
              reviewRetired: true,
              trackingReleased: true,
              error: "unknownRequest",
            });
          }
        } else this.accept(f, raw);
      })
      .catch((reason) => {
        clearTimeout(timer);
        if (!this.attached(f) || !f.view.unresolved || epoch !== f.epoch)
          return;
        const code = skillChangeFailure(reason) ?? "unavailable";
        // Only these direct, fresh confirm errors are guaranteed before admission.
        // A timeout/status/other failure cannot be reclassified as an unwritten request.
        if (
          freshConfirmation &&
          !f.lost &&
          !f.view.operation &&
          (code === "reviewExpired" || code === "reviewConsumed")
        ) {
          f.retired = true;
          this.publish(f, {
            checking: false,
            unresolved: false,
            admissionRejected: true,
            review: null,
            reviewRetired: true,
            error: code,
          });
          return;
        }
        if (freshConfirmation) f.target.changed();
        this.publish(f, { checking: false, error: code });
      });
  }
  inspect(target: SkillChangeTargetOwner): boolean {
    const { result, item, owner } = target;
    const previous = this.entries.get(owner.agentId);
    if (
      !owner.current() ||
      !target.current() ||
      result.owner !== owner ||
      result.request.kind !== "skills" ||
      result.request.agentId !== owner.agentId ||
      result.stale ||
      result.snapshot.source !== "officialAppServer" ||
      !result.snapshot.complete ||
      result.snapshot.items[item.id] !== item ||
      !item.name ||
      !["user", "repo"].includes(item.origin) ||
      item.pluginReported ||
      item.enablement.availability !== "reviewable" ||
      previous?.view.unresolved
    )
      return false;
    if (!previous && this.entries.size >= 64) {
      const old = [...this.entries].find(([, v]) => !v.view.unresolved);
      if (!old) return false;
      this.revokeReview(old[1]);
      this.entries.delete(old[0]);
    }
    if (previous) {
      previous.retired = true;
      this.revokeReview(previous);
    }
    const request: SkillChangeRequest = Object.freeze({
      agentId: owner.agentId,
      requestId: this.uuid(),
      action: "inspect",
      cwd: result.request.cwd,
      target: Object.freeze({
        inventoryRequestId: result.request.requestId,
        itemId: item.id,
        name: item.name,
        origin: item.origin as "user" | "repo",
      }),
      requestedEnabled: !item.reportedEnabled,
      operationId: null,
    });
    const f: Flight = {
      target,
      view: { ...EMPTY, request, unresolved: true },
      retired: false,
      consumed: false,
      dispatched: false,
      lost: false,
      epoch: 0,
      inspection: request,
      inspectionRevoked: false,
      confirmation: null,
      reviewDeadline: null,
      inheritedWrite: null,
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    if (!this.current(f)) {
      this.publish(f, {
        unresolved: false,
        reviewRetired: true,
        error: "selectionChanged",
      });
      return false;
    }
    this.observe(f, async () => {
      if (!this.current(f) || f.view.cancelRequested) {
        this.publish(f, {
          unresolved: false,
          reviewRetired: true,
          error: "selectionChanged",
        });
        return;
      }
      f.dispatched = true;
      return this.port.inspect({
        agentId: request.agentId,
        requestId: request.requestId,
        inventoryRequestId: request.target.inventoryRequestId,
        itemId: request.target.itemId,
        enabled: request.requestedEnabled,
      });
    });
    return true;
  }
  canConfirm(owner: InventoryOwner, review: SkillChangeReview): boolean {
    const f = this.entries.get(owner.agentId);
    return (
      !!f &&
      f.target.owner === owner &&
      this.current(f) &&
      !f.view.unresolved &&
      !f.consumed &&
      !f.inspectionRevoked &&
      f.view.review === review &&
      f.view.operation?.state === "ready" &&
      f.reviewDeadline !== null &&
      this.now() < f.reviewDeadline
    );
  }
  confirm(owner: InventoryOwner, review: SkillChangeReview): boolean {
    if (!this.canConfirm(owner, review)) return false;
    const old = this.entries.get(owner.agentId)!;
    old.consumed = true;
    const request: SkillChangeRequest = Object.freeze({
      ...old.inspection,
      requestId: this.uuid(),
      action: "setEnabled",
      target: Object.freeze({ ...review.target }),
    });
    const f: Flight = {
      ...old,
      view: { ...EMPTY, request, unresolved: true, reviewRetired: true },
      dispatched: false,
      epoch: 0,
      lost: false,
      confirmation: request,
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    // A synchronous subscriber may retire this exact owner before IPC admission.
    if (!this.current(f)) {
      this.publish(f, { unresolved: false, error: "selectionChanged" });
      return false;
    }
    this.observe(
      f,
      async () => {
        if (!this.current(f) || f.view.cancelRequested) {
          this.publish(f, { unresolved: false, error: "selectionChanged" });
          return;
        }
        f.dispatched = true;
        return this.port.confirm({
          agentId: request.agentId,
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
    if (this.attached(f) && f.view.unresolved)
      this.observe(f, () => this.port.status({ agentId, requestId }));
  }
  cancel(agentId: string, requestId: string, explicit = true) {
    const f = this.entries.get(agentId);
    if (!f || f.view.request?.requestId !== requestId) return;
    const releaseAbsent = explicit && f.view.error === "unknownRequest";
    f.retired = true;
    if (f.view.request.action === "inspect" && f.view.unresolved)
      f.inspectionRevoked = true;
    else this.revokeReview(f);
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
  }
  retire(owner: InventoryOwner) {
    const f = this.entries.get(owner.agentId);
    if (!f || f.target.owner !== owner || f.retired) return;
    if (f.view.unresolved && f.view.request)
      this.cancel(owner.agentId, f.view.request.requestId, false);
    else {
      f.retired = true;
      this.revokeReview(f);
      this.publish(f, { review: null, reviewRetired: true });
    }
  }
  retireInspectionForResult(
    owner: InventoryOwner,
    result: InventoryResult | undefined,
  ) {
    const f = this.entries.get(owner.agentId);
    if (
      f?.target.owner === owner &&
      f.view.request?.action === "inspect" &&
      f.target.result !== result
    )
      this.retire(owner);
  }
  recheck(agentId: string, requestId: string): boolean {
    const old = this.entries.get(agentId);
    if (
      !old ||
      old.view.request?.requestId !== requestId ||
      old.view.unresolved ||
      !old.view.operation?.settled ||
      !old.view.operation.writeDispatched ||
      !old.confirmation
    )
      return false;
    const request: SkillChangeRequest = Object.freeze({
      ...old.confirmation,
      requestId: this.uuid(),
      action: "recheck",
      operationId: old.confirmation.requestId,
    });
    const f: Flight = {
      ...old,
      view: { ...EMPTY, request, unresolved: true, reviewRetired: true },
      retired: true,
      dispatched: true,
      epoch: 0,
      lost: false,
      inheritedWrite: {
        writeDispatched: old.view.operation.writeDispatched,
        writeAck: old.view.operation.writeAck,
      },
    };
    this.entries.set(agentId, f);
    this.publish(f, {});
    if (!this.attached(f) || f.view.cancelRequested) return false;
    this.observe(f, () =>
      this.port.recheck({
        agentId,
        requestId: request.requestId,
        operationId: request.operationId!,
      }),
    );
    return true;
  }
}
export const skillManagement = new SkillManagementController();
