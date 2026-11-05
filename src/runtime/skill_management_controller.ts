import { mcpRemovePort } from "./mcp_remove";
import { mcpRemoveFailure, type McpRemoveCode } from "./mcp_remove_types";
import { mcpAddPort } from "./mcp_add";
import {
  freezeMcpAddInput,
  isHttpInput,
  mcpAddFailure,
  type McpAddInput,
  type McpAddCode,
} from "./mcp_add_types";
import type {
  InventoryOwner,
  InventoryResult,
} from "./extension_inventory_controller";
import {
  skillManagementPort,
  type SkillManagementPort,
} from "./skill_management";
import { mcpManagementPort } from "./mcp_management";
import {
  parseExtensionChangeOperation as parseSkillChangeOperation,
  parseExtensionChangeCancellation as parseSkillChangeCancellation,
  type ExtensionChangeRequest as SkillChangeRequest,
  type ExtensionChangeOperation as SkillChangeOperation,
  type ExtensionChangeReview as SkillChangeReview,
  type ExtensionChangeTargetOwner as SkillChangeTargetOwner,
  requestForTarget,
  confirmedRequest,
  isMcpRequest,
  isAddRequest,
  isRemoveRequest,
} from "./extension_management_types";
export type { ExtensionChangeTargetOwner as SkillChangeTargetOwner } from "./extension_management_types";

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
  error: McpAddCode | McpRemoveCode | null;
  originalOperation: SkillChangeOperation | null;
  additionInput: McpAddInput | null;
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
  additionInput: null,
  originalOperation: null,
});
type ChangeTarget = Pick<
  SkillChangeTargetOwner,
  "owner" | "result" | "current" | "changed"
>;
type RemovalParent = "mayRemainEmpty" | "preserveSiblings" | null;
interface LastWrite {
  request: SkillChangeRequest;
  operation: SkillChangeOperation;
  port: SkillManagementPort;
  target: ChangeTarget;
  removalParent: RemovalParent;
}
interface Flight {
  port: SkillManagementPort;
  target: ChangeTarget;
  view: SkillManagementView;
  retired: boolean;
  consumed: boolean;
  dispatched: boolean;
  lost: boolean;
  epoch: number;
  inspection: SkillChangeRequest;
  inspectionRevoked: boolean;
  lastWrite: LastWrite | null;
  reviewDeadline: number | null;
  removalParent: RemovalParent;
  inheritedWrite: Pick<
    SkillChangeOperation,
    "writeDispatched" | "writeAck"
  > | null;
}
/** Shared skill/MCP operation per Agent; public results only, no persistent task ledger. */
export class SkillManagementController {
  private entries = new Map<string, Flight>();
  private listeners = new Set<() => void>();
  constructor(
    private port: SkillManagementPort = skillManagementPort,
    private waitMs = 10000,
    private uuid: () => string = () => crypto.randomUUID(),
    private now = () => Date.now(),
    private mcpPort: SkillManagementPort = mcpManagementPort,
    private addPort: SkillManagementPort = mcpAddPort,
    private removePort: SkillManagementPort = mcpRemovePort,
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
  private dropHttpInput(f: Flight) {
    if (
      !f.view.request ||
      !isAddRequest(f.view.request) ||
      f.view.request.target.transport !== "streamableHttp" ||
      f.view.additionInput === null
    )
      return false;
    // Preserve only safe ownership and callbacks needed for status/marking stale.
    f.target = {
      owner: f.target.owner,
      result: f.target.result,
      current: () => false,
      changed: f.target.changed,
    };
    f.view = { ...f.view, additionInput: null };
    return true;
  }
  private revokeReview(f: Flight) {
    if (f.inspectionRevoked) return;
    f.inspectionRevoked = true;
    void Promise.resolve()
      .then(() =>
        f.port.cancel({
          agentId: f.inspection.agentId,
          requestId: f.inspection.requestId,
        }),
      )
      .catch(() => {});
  }
  private accept(f: Flight, raw: unknown) {
    if (!this.attached(f) || !f.view.unresolved || !f.view.request) return;
    if (!this.current(f)) this.dropHttpInput(f);
    const op = parseSkillChangeOperation(raw, f.view.request),
      old = f.view.operation;
    if (
      f.inheritedWrite &&
      (op.writeDispatched !== f.inheritedWrite.writeDispatched ||
        op.writeAck !== f.inheritedWrite.writeAck)
    )
      throw { code: "invalidOutput" };
    if (
      f.removalParent !== null &&
      op.observation &&
      "parentOutcome" in op.observation &&
      op.observation.configuration === "matching" &&
      (f.removalParent === "preserveSiblings"
        ? op.observation.parentOutcome !== "nonempty"
        : !["empty", "absent"].includes(op.observation.parentOutcome ?? ""))
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
    // A read or an undispatched confirmation never replaces the last actual write.
    if (
      op.writeDispatched &&
      ["setEnabled", "add", "remove"].includes(f.view.request.action)
    )
      f.lastWrite = {
        request: f.view.request,
        operation: op,
        port: f.port,
        target: f.target,
        removalParent: f.removalParent,
      };
    if (op.writeDispatched) f.target.changed();
    this.publish(f, {
      operation: op,
      originalOperation: f.lastWrite?.operation ?? null,
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
        if (
          ["setEnabled", "add", "remove"].includes(f.view.request?.action ?? "")
        )
          f.target.changed();
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
        const code =
          (f.view.request && isRemoveRequest(f.view.request)
            ? mcpRemoveFailure(reason)
            : mcpAddFailure(reason)) ?? "unavailable";
        // Only these direct, fresh confirm errors are guaranteed before admission.
        // A timeout/status/other failure cannot be reclassified as an unwritten request.
        if (
          freshConfirmation &&
          !f.lost &&
          !f.view.operation &&
          (code === "reviewExpired" || code === "reviewConsumed")
        ) {
          f.retired = true;
          this.dropHttpInput(f);
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
  inspect(inputTarget: SkillChangeTargetOwner): boolean {
    // Copy the admitted form input; external edits never mutate the original review data.
    let target = inputTarget;
    if ("input" in inputTarget) {
      try {
        target = {
          ...inputTarget,
          input: freezeMcpAddInput(inputTarget.input),
        };
      } catch {
        return false;
      }
    }
    const { owner } = target;
    const previous = this.entries.get(owner.agentId);
    const request = requestForTarget(target, this.uuid());
    if (!request || previous?.view.unresolved) return false;
    if (!previous && this.entries.size >= 64) {
      const old = [...this.entries].find(([, v]) => !v.view.unresolved);
      if (!old) return false;
      this.dropHttpInput(old[1]);
      this.revokeReview(old[1]);
      this.entries.delete(old[0]);
    }
    if (previous) {
      previous.retired = true;
      this.dropHttpInput(previous);
      this.revokeReview(previous);
    }
    const f: Flight = {
      port: isRemoveRequest(request)
        ? this.removePort
        : isAddRequest(request)
          ? this.addPort
          : isMcpRequest(request)
            ? this.mcpPort
            : this.port,
      target:
        "input" in target && isHttpInput(target.input)
          ? {
              owner: target.owner,
              result: target.result,
              current: target.current,
              changed: target.changed,
            }
          : target,
      view: {
        ...EMPTY,
        request,
        unresolved: true,
        originalOperation: previous?.lastWrite?.operation ?? null,
        additionInput: "input" in target ? target.input : null,
      },
      retired: false,
      consumed: false,
      dispatched: false,
      lost: false,
      epoch: 0,
      inspection: request,
      inspectionRevoked: false,
      lastWrite: previous?.lastWrite ?? null,
      reviewDeadline: null,
      inheritedWrite: null,
      removalParent: null,
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    if (!this.current(f)) {
      this.dropHttpInput(f);
      this.publish(f, {
        unresolved: false,
        reviewRetired: true,
        error: "selectionChanged",
      });
      return false;
    }
    this.observe(f, async () => {
      if (!this.current(f) || f.view.cancelRequested) {
        this.dropHttpInput(f);
        this.publish(f, {
          unresolved: false,
          reviewRetired: true,
          error: "selectionChanged",
        });
        return;
      }
      f.dispatched = true;
      if (isAddRequest(request)) {
        if (!f.view.additionInput) throw { code: "invalidRequest" };
        return f.port.inspect({
          agentId: request.agentId,
          requestId: request.requestId,
          inventoryRequestId: request.target.inventoryRequestId,
          inputId: request.target.inputId,
          input: f.view.additionInput,
        });
      }
      if (isRemoveRequest(request))
        return f.port.inspect({
          agentId: request.agentId,
          requestId: request.requestId,
          inventoryRequestId: request.target.inventoryRequestId,
          itemId: request.target.itemId,
        });
      return f.port.inspect({
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
    const request = Object.freeze(
      confirmedRequest(old.inspection, review, this.uuid()),
    );
    const f: Flight = {
      ...old,
      view: {
        ...EMPTY,
        request,
        unresolved: true,
        reviewRetired: true,
        originalOperation: old.lastWrite?.operation ?? null,
        additionInput: old.view.additionInput,
      },
      dispatched: false,
      epoch: 0,
      lost: false,
      removalParent: "parentHandling" in review ? review.parentHandling : null,
    };
    this.entries.set(owner.agentId, f);
    this.publish(f, {});
    // A synchronous subscriber may retire this exact owner before IPC admission.
    if (!this.current(f)) {
      this.dropHttpInput(f);
      this.publish(f, { unresolved: false, error: "selectionChanged" });
      return false;
    }
    this.observe(
      f,
      async () => {
        if (!this.current(f) || f.view.cancelRequested) {
          this.dropHttpInput(f);
          this.publish(f, { unresolved: false, error: "selectionChanged" });
          return;
        }
        f.dispatched = true;
        return f.port.confirm({
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
      this.observe(f, () => f.port.status({ agentId, requestId }));
  }
  cancel(agentId: string, requestId: string, explicit = true) {
    const f = this.entries.get(agentId);
    if (!f || f.view.request?.requestId !== requestId) return;
    const releaseAbsent = explicit && f.view.error === "unknownRequest";
    f.retired = true;
    this.dropHttpInput(f);
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
        () => f.port.cancel({ agentId, requestId }),
        true,
        releaseAbsent,
      );
  }
  retire(owner: InventoryOwner) {
    const f = this.entries.get(owner.agentId);
    if (!f || f.target.owner !== owner) return;
    const inputDropped = this.dropHttpInput(f);
    if (f.retired) {
      if (inputDropped) this.publish(f, {});
      return;
    }
    if (f.view.unresolved && f.view.request)
      this.cancel(owner.agentId, f.view.request.requestId, false);
    else {
      f.retired = true;
      this.revokeReview(f);
      this.publish(f, { review: null, reviewRetired: true });
    }
  }
  retireAddition(
    owner: InventoryOwner,
    inputId: string,
    resultReplaced = false,
  ) {
    const f = this.entries.get(owner.agentId);
    if (
      f?.target.owner === owner &&
      f.view.request &&
      (f.view.request.action === "inspect" ||
        (isAddRequest(f.view.request) &&
          f.view.request.target.transport === "streamableHttp")) &&
      isAddRequest(f.view.request) &&
      f.view.request.target.inputId === inputId
    ) {
      if (
        resultReplaced &&
        f.view.request.action !== "inspect" &&
        f.dispatched
      ) {
        // Our write marks its catalogue stale. Drop only the private form data;
        // keep the admitted operation, including its later explicit cancel path.
        this.dropHttpInput(f);
        this.publish(f, { review: null, reviewRetired: true });
      } else this.retire(owner);
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
    const old = this.entries.get(agentId),
      write = old?.lastWrite;
    if (
      !old ||
      old.view.request?.requestId !== requestId ||
      old.view.unresolved ||
      !write?.operation.settled ||
      !write.operation.writeDispatched
    )
      return false;
    this.dropHttpInput(old);
    this.revokeReview(old);
    const request: SkillChangeRequest = Object.freeze({
      ...write.request,
      requestId: this.uuid(),
      action: "recheck",
      operationId: write.request.requestId,
    });
    const f: Flight = {
      ...old,
      port: write.port,
      target: write.target,
      view: {
        ...EMPTY,
        request,
        unresolved: true,
        reviewRetired: true,
        originalOperation: write.operation,
      },
      retired: true,
      inspectionRevoked: true,
      removalParent: write.removalParent,
      dispatched: true,
      epoch: 0,
      lost: false,
      inheritedWrite: {
        writeDispatched: write.operation.writeDispatched,
        writeAck: write.operation.writeAck,
      },
    };
    this.entries.set(agentId, f);
    this.publish(f, {});
    if (!this.attached(f) || f.view.cancelRequested) return false;
    this.observe(f, () =>
      f.port.recheck({
        agentId,
        requestId: request.requestId,
        operationId: request.operationId!,
      }),
    );
    return true;
  }
}
export const skillManagement = new SkillManagementController();
