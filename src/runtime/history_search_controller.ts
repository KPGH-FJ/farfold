import { historySearchPort, type HistorySearchPort } from "./history_search";
import {
  historySearchError,
  parseHistoryReply,
  parseHistorySelection,
  validHistoryQuery,
  type HistorySearchCode,
  type HistorySearchExpected,
  type HistorySearchOperation,
  type HistorySearchSelection,
  type HistorySearchSource,
} from "./history_search_types";

export interface HistorySearchOwner {
  agentId: string;
  /** A view-local authority; returning to equal values never revives it. */
  current(): boolean;
}
export interface HistorySearchFlight {
  expected: HistorySearchExpected;
  source: HistorySearchSource;
  owner: HistorySearchOwner | null;
  operation: HistorySearchOperation | null;
  admissionClosed: boolean;
  unconfirmed: boolean;
  cancelRequested: boolean;
  checking: boolean;
  cancelling: boolean;
  releasing: boolean;
  error: HistorySearchCode | null;
}
export interface HistorySearchView {
  preparing: boolean;
  selection: HistorySearchSelection | null;
  error: HistorySearchCode | null;
  flight: HistorySearchFlight | null;
}
interface Slot extends HistorySearchView {
  owner: HistorySearchOwner | null;
  preparation: object | null;
  expiresAt: number;
}
const empty: HistorySearchView = {
  preparing: false,
  selection: null,
  error: null,
  flight: null,
};

/** One bounded in-memory observation per Agent; no transcript or history persistence. */
export class HistorySearchController {
  private slots = new Map<string, Slot>();
  private retiredOwners = new WeakSet<HistorySearchOwner>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(
    private port: HistorySearchPort = historySearchPort,
    private uuid: () => string = () => crypto.randomUUID(),
    private now = () => Date.now(),
    private timeoutMs = 16000,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  get(agentId: string): HistorySearchView {
    return this.slots.get(agentId) ?? empty;
  }
  trackedAgents(): string[] {
    return [...this.slots].filter(([, slot]) => slot.flight).map(([id]) => id);
  }
  private emit() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
  private slot(agentId: string): Slot | null {
    const old = this.slots.get(agentId);
    if (old) return old;
    if (this.slots.size >= 32) return null;
    const slot: Slot = {
      ...empty,
      owner: null,
      preparation: null,
      expiresAt: 0,
    };
    this.slots.set(agentId, slot);
    return slot;
  }
  async prepare(owner: HistorySearchOwner, rowIds: readonly string[]) {
    if (
      this.retiredOwners.has(owner) ||
      !owner.current() ||
      !rowIds.length ||
      rowIds.length > 20 ||
      new Set(rowIds).size !== rowIds.length
    )
      return false;
    const slot = this.slot(owner.agentId);
    if (!slot || slot.flight) return false;
    const preparation = {};
    slot.owner = owner;
    slot.preparation = preparation;
    slot.selection = null;
    slot.preparing = true;
    slot.error = null;
    this.emit();
    const current = () =>
      this.slots.get(owner.agentId) === slot &&
      slot.preparation === preparation &&
      slot.owner === owner &&
      owner.current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        if (current()) {
          slot.preparation = null;
          slot.preparing = false;
          slot.error = "timedOut";
          this.emit();
        }
        resolve(false);
      }, this.timeoutMs);
    });
    const read = (async () => {
      try {
        if (!current()) return false;
        const raw = await this.port.capabilities({
          agentId: owner.agentId,
          rowIds: [...rowIds],
        });
        if (!current()) return false;
        const selection = parseHistorySelection(raw, owner.agentId, rowIds);
        slot.selection = selection;
        slot.expiresAt = this.now() + selection.validForMs;
        slot.error = selection.code;
        return selection.availability === "available";
      } catch (e) {
        if (current()) slot.error = historySearchError(e);
        return false;
      } finally {
        if (timer) clearTimeout(timer);
        if (current()) {
          slot.preparing = false;
          this.emit();
        }
      }
    })();
    return Promise.race([read, timeout]);
  }
  start(owner: HistorySearchOwner, query: string) {
    const slot = this.slots.get(owner.agentId);
    if (
      !slot ||
      slot.flight ||
      slot.owner !== owner ||
      this.retiredOwners.has(owner) ||
      !owner.current() ||
      !validHistoryQuery(query)
    )
      return false;
    const selection = slot.selection;
    if (
      selection?.availability !== "available" ||
      !selection.selectionId ||
      !selection.source ||
      this.now() >= slot.expiresAt
    ) {
      slot.selection = null;
      slot.error = "selectionChanged";
      this.emit();
      return false;
    }
    const flight: HistorySearchFlight = {
      source: selection.source,
      expected: {
        agentId: owner.agentId,
        requestId: this.uuid(),
        selectionId: selection.selectionId,
        rowIds: selection.rows.map((r) => r.rowId),
        query,
      },
      owner,
      operation: null,
      admissionClosed: false,
      unconfirmed: false,
      cancelRequested: false,
      checking: false,
      cancelling: false,
      releasing: false,
      error: null,
    };
    slot.flight = flight;
    slot.selection = null;
    slot.error = null;
    this.emit();
    // Install ownership before dispatch so even a synchronous close can exact-cancel.
    if (!owner.current() || flight.owner !== owner) {
      this.retire(owner);
      return false;
    }
    const { rowIds: _rowIds, ...request } = flight.expected;
    void this.observe(slot, flight, "start", () => this.port.start(request));
    return true;
  }
  private owns(slot: Slot, flight: HistorySearchFlight) {
    return (
      this.slots.get(flight.expected.agentId) === slot && slot.flight === flight
    );
  }
  private async observe(
    slot: Slot,
    flight: HistorySearchFlight,
    action: "start" | "status" | "cancel",
    run: () => Promise<unknown>,
  ) {
    if (!this.owns(slot, flight)) return;
    if (
      (action === "status" && flight.checking) ||
      (action === "cancel" && flight.cancelling)
    )
      return;
    if (action === "status") flight.checking = true;
    if (action === "cancel") flight.cancelling = true;
    const priorRevision = flight.operation?.revision ?? -1;
    this.emit();
    const timer = setTimeout(() => {
      if (
        !this.owns(slot, flight) ||
        (flight.operation?.revision ?? -1) > priorRevision ||
        flight.operation?.settled ||
        flight.admissionClosed
      )
        return;
      flight.unconfirmed = true;
      flight.error = "timedOut";
      if (action === "status") flight.checking = false;
      if (action === "cancel") flight.cancelling = false;
      this.emit();
    }, this.timeoutMs);
    try {
      const raw = await run();
      if (!this.owns(slot, flight)) return;
      const reply = parseHistoryReply(raw, flight.expected, flight.source);
      if (reply.kind === "absent") {
        if (flight.operation?.settled) return;
        if (reply.admissionClosed) {
          flight.admissionClosed = true;
          flight.unconfirmed = false;
          flight.operation = null;
          flight.error = null;
        } else if (!flight.operation) flight.unconfirmed = true;
      } else if (!flight.admissionClosed) {
        const op = reply.operation;
        if (
          flight.operation &&
          (op.revision <= flight.operation.revision || flight.operation.settled)
        )
          return;
        if (flight.owner && !flight.owner.current()) this.retire(flight.owner);
        flight.operation = flight.owner ? op : { ...op, hits: [] };
        flight.unconfirmed = false;
        flight.error = null;
      }
    } catch (e) {
      if (
        this.owns(slot, flight) &&
        !flight.admissionClosed &&
        !flight.operation?.settled &&
        (flight.operation?.revision ?? -1) === priorRevision
      ) {
        flight.error = historySearchError(e);
        flight.unconfirmed = true;
      }
    } finally {
      clearTimeout(timer);
      if (this.owns(slot, flight)) {
        if (action === "status") flight.checking = false;
        if (action === "cancel") flight.cancelling = false;
        this.emit();
      }
    }
  }
  check(agentId: string, requestId: string) {
    const slot = this.slots.get(agentId),
      flight = slot?.flight;
    if (
      slot &&
      flight &&
      flight.expected.requestId === requestId &&
      !flight.admissionClosed
    )
      void this.observe(slot, flight, "status", () =>
        this.port.status(this.identity(flight)),
      );
  }
  private identity(flight: HistorySearchFlight) {
    return {
      agentId: flight.expected.agentId,
      requestId: flight.expected.requestId,
    };
  }
  cancel(agentId: string, requestId: string) {
    const slot = this.slots.get(agentId),
      flight = slot?.flight;
    if (
      !slot ||
      !flight ||
      flight.expected.requestId !== requestId ||
      flight.operation?.settled ||
      flight.admissionClosed
    )
      return;
    flight.cancelRequested = true;
    this.emit();
    void this.observe(slot, flight, "cancel", () =>
      this.port.cancel(this.identity(flight)),
    );
  }
  retire(owner: HistorySearchOwner) {
    this.retiredOwners.add(owner);
    const slot = this.slots.get(owner.agentId);
    if (!slot) return;
    let changed = false;
    if (slot.owner === owner) {
      changed = true;
      slot.owner = null;
      slot.preparation = null;
      slot.preparing = false;
      slot.selection = null;
      slot.error = null;
    }
    const flight = slot.flight;
    if (flight?.owner === owner) {
      changed = true;
      flight.owner = null;
      if (flight.operation)
        flight.operation = { ...flight.operation, hits: [] };
      this.cancel(owner.agentId, flight.expected.requestId);
    }
    if (changed) this.emit();
  }
  async dismiss(agentId: string, requestId: string) {
    const slot = this.slots.get(agentId),
      flight = slot?.flight;
    if (
      !slot ||
      !flight ||
      flight.expected.requestId !== requestId ||
      flight.releasing ||
      (!flight.admissionClosed && !flight.operation?.settled)
    )
      return false;
    if (flight.admissionClosed) {
      this.slots.delete(agentId);
      this.emit();
      return true;
    }
    flight.releasing = true;
    this.emit();
    try {
      if (
        (await this.port.release(this.identity(flight))) !== true ||
        !this.owns(slot, flight)
      )
        return false;
      this.slots.delete(agentId);
      this.emit();
      return true;
    } catch {
      return false;
    } finally {
      if (this.owns(slot, flight)) {
        flight.releasing = false;
        this.emit();
      }
    }
  }
}
export const historySearch = new HistorySearchController();
