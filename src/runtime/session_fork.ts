import { SessionDeliveryObserver } from "./session_delivery_observer";
import { invoke } from "@tauri-apps/api/core";
import { OwnedSessionChannel } from "./session_channels";
import {
  configurationInputBusy,
  sameConfigurationSnapshot,
} from "./config_check";
import { draftPersistence } from "./drafts";
import { openingInquiries } from "./opening_inquiries";
import { historyReads } from "./session_history_admission";
import { configChangeBusy } from "./protected_config";
import { hasOwnUpdate, SessionOpenReplay } from "./session_open_replay";
import { retireForkControlOwner, validForkId } from "./session_fork_activity";
import type { ForkOperation, ForkResult } from "./session_fork_types";
import { SESSION_FORK_STRINGS as S } from "./session_fork_strings";
import type { ThreadState } from "./session_types";
import type { IndexRow } from "./sessions";
import {
  hasHistoryForkPoint,
  sameHistoryForkPoint,
  type HistoryForkPoint,
} from "./history_fork_point";

export function forkBlockReason(
  thread: ThreadState,
  historyPoint?: HistoryForkPoint,
): string | undefined {
  if (
    historyPoint
      ? !thread.sessionOperations?.forkHistoricalPoint
      : !thread.sessionOperations?.forkCurrentContext
  )
    return S.unsupported;
  if (historyPoint && !hasHistoryForkPoint(thread, historyPoint))
    return S.pointUnavailable;
  if (
    thread.identity !== "established" ||
    !thread.connectionId ||
    thread.connectionLost ||
    thread.openError ||
    thread.unrecoverable ||
    thread.historyUnavailable ||
    thread.sourceError
  )
    return S.unavailableOwner;
  if (
    thread.configError ||
    thread.modelDrift ||
    thread.configCheck?.status !== "ready" ||
    (thread.permissionConfigId && thread.permissionState !== "ready")
  )
    return S.configuration;
  if (
    configChangeBusy(thread) ||
    configurationInputBusy(thread) ||
    !thread.workEnabled ||
    ["pending", "unknown", "created_unavailable"].includes(
      thread.forkOperation?.status ?? "",
    )
  )
    return S.busy;
  return undefined;
}

interface Ports {
  thread(key: string): ThreadState | undefined;
  rows(): readonly IndexRow[];
  install(
    state: ThreadState,
    channel: OwnedSessionChannel,
    permissionChanges: number,
  ): void;
  ownsChannel(key: string, channel: OwnedSessionChannel): boolean;
  apply(key: string, event: unknown, live?: boolean): void;
  emit(key?: string): void;
  refreshIndex(): Promise<void>;
}

/** Coordinates delivery only; the backend owns the single official fork and
 * process handoff. A rejected/unknown IPC call never triggers a second fork. */
export class SessionForks {
  private unbound = new Map<
    ThreadState,
    {
      operation: ForkOperation;
      channel: OwnedSessionChannel;
      clear(): void;
    }
  >();

  /** Retire only renderer delivery when its exact source view is removed or
   * explicitly replaced. Unknown Agent work is neither stopped nor retried. */
  retire(parent: ThreadState): void {
    const owner = this.unbound.get(parent);
    if (!owner) return;
    this.unbound.delete(parent);
    owner.clear();
    owner.channel.dispose();
  }

  private requests = new Map<
    string,
    { operationId: string; promise: Promise<ThreadState | undefined> }
  >();
  constructor(private ports: Ports) {}

  prepareNew(key: string, operationId: string): boolean {
    const parent = this.ports.thread(key);
    const operation = parent?.forkOperation;
    if (
      !parent ||
      !operation ||
      this.requests.has(key) ||
      operation.operationId !== operationId ||
      operation.connectionId !== parent.connectionId ||
      operation.parentSessionId !== parent.nativeSessionId ||
      !operation.sourceReleased ||
      !["ready", "rejected"].includes(operation.status)
    )
      return false;
    this.retire(parent);
    retireForkControlOwner(parent);
    parent.forkOperation = undefined;
    this.ports.emit(key);
    return true;
  }

  start(
    key: string,
    historyPoint?: HistoryForkPoint,
  ): Promise<ThreadState | undefined> {
    const active = this.requests.get(key);
    if (active)
      return sameHistoryForkPoint(
        this.ports.thread(key)?.forkOperation?.historyPoint,
        historyPoint,
      )
        ? active.promise
        : Promise.resolve(undefined);
    const parent = this.ports.thread(key);
    if (!parent || forkBlockReason(parent, historyPoint))
      return Promise.resolve(undefined);
    const operation: ForkOperation = {
      operationId: crypto.randomUUID(),
      connectionId: parent.connectionId!,
      parentSessionId: parent.nativeSessionId,
      status: "pending",
      sourceReleased: false,
      indexed: false,
      ...(historyPoint ? { historyPoint: { ...historyPoint } } : {}),
    };
    this.retire(parent);
    parent.forkOperation = operation;
    this.ports.emit(parent.key);
    const request = this.perform(parent, operation).finally(() => {
      if (this.requests.get(key)?.operationId === operation.operationId)
        this.requests.delete(key);
    });
    this.requests.set(key, {
      operationId: operation.operationId,
      promise: request,
    });
    return request;
  }

  private async perform(
    parent: ThreadState,
    operation: ForkOperation,
  ): Promise<ThreadState | undefined> {
    const current = () =>
      this.ports.thread(parent.key) === parent &&
      parent.connectionId === operation.connectionId &&
      parent.nativeSessionId === operation.parentSessionId &&
      parent.forkOperation === operation;
    const baseline = structuredClone({
      check: parent.configCheck,
      options: parent.configOptions,
      service: parent.service,
      serviceContext: parent.serviceContext,
    });
    let receivingReplay = true;
    const openToken = crypto.randomUUID();
    const replay = new SessionOpenReplay(
      { agentId: parent.agentId, cwd: parent.cwd },
      undefined,
      undefined,
      openToken,
      current,
    );
    const delivery = new SessionDeliveryObserver(parent.agentId, openToken);
    const channel = new OwnedSessionChannel(delivery);
    this.unbound.set(parent, {
      operation,
      channel,
      clear: () => {
        receivingReplay = false;
        replay.clear();
      },
    });
    const transferOwner = () => {
      if (this.unbound.get(parent)?.operation === operation)
        this.unbound.delete(parent);
    };
    const readKey = `fork:${operation.operationId}`;
    const admission = historyReads.begin(
      readKey,
      {
        agentId: parent.agentId,
        cwd: parent.cwd,
        nativeSessionId: parent.nativeSessionId,
        inquiryCurrent: current,
      },
      openToken,
      "fork",
    );
    const inquiry = openingInquiries.begin(`fork:${operation.operationId}`, {
      agentId: parent.agentId,
      cwd: parent.cwd,
      inquiryCurrent: current,
    });
    let dispatched = false;
    let boundKey: string | undefined;
    channel.onmessage = (input) =>
      delivery.receive(input, (event) => {
        const received = event as {
          kind?: unknown;
          openToken?: unknown;
        } | null;
        if (!hasOwnUpdate(event) && received?.kind === "forkSourceEvent") {
          const source = event as {
            operationId?: unknown;
            childSessionId?: unknown;
            event?: unknown;
          };
          if (!current() || source.operationId !== operation.operationId)
            return "discarded";
          const inner = source.event as Record<string, unknown> | null;
          if (!inner || typeof inner !== "object") return "discarded";
          if (inner.kind === "permissionRequest") {
            const owner = inner.owner as Record<string, unknown> | null;
            const expected =
              source.childSessionId === null
                ? operation.parentSessionId
                : source.childSessionId;
            if (
              !owner ||
              owner.connectionId !== operation.connectionId ||
              owner.sessionId !== expected
            )
              return "discarded";
          }
          if (source.childSessionId === null) {
            // Before fork returns an ID, reverse requests belong to its actual
            // request scope on the parent connection, not an invented child.
            if (inner.kind === "elicitation") {
              const owner = inner.owner as Record<string, unknown> | null;
              if (
                !owner ||
                owner.connectionId !== operation.connectionId ||
                !(
                  owner.sessionId === operation.parentSessionId ||
                  (owner.sessionId === undefined &&
                    validForkId(owner.requestId))
                )
              )
                return "discarded";
            }
          } else if (
            !validForkId(source.childSessionId) ||
            (operation.childSessionId &&
              operation.childSessionId !== source.childSessionId)
          )
            return "discarded";
          return !hasOwnUpdate(inner) && inquiry.receive(inner)
            ? "consumed"
            : "discarded";
        }
        if (!hasOwnUpdate(event) && received?.kind === "forkResult") {
          const delivered = event as {
            operationId?: unknown;
            result?: ForkResult;
            settled?: unknown;
          };
          if (
            !current() ||
            delivered.operationId !== operation.operationId ||
            !delivered.result ||
            typeof delivered.settled !== "boolean"
          )
            return "discarded";
          const errorBefore = operation.deliveryError;
          // Queuing result work is not consumption. Await its existing owner
          // validation and actual metadata/replay projection before sampling it.
          return queueResult(
            delivered.result,
            delivered.settled,
            "channel",
          ).then(
            () =>
              operation.deliveryError !== errorBefore
                ? "error"
                : current()
                  ? "consumed"
                  : "discarded",
            () => "error",
          );
        }
        if (receivingReplay && current() && replay.receiveMarker(event))
          return "consumed";
        if (boundKey) {
          if (
            !this.ports.ownsChannel(boundKey, channel) ||
            !this.ports.thread(boundKey)
          )
            return "discarded";
          this.ports.apply(boundKey, event);
          return "consumed";
        }
        if (!current()) return "discarded";
        if (!hasOwnUpdate(event) && inquiry.receive(event)) return "consumed";
        if (!receivingReplay) return "discarded";
        admission?.observeRaw();
        return replay.push(event);
      });
    let updates = Promise.resolve<ThreadState | undefined>(undefined);
    const queueResult = (
      result: ForkResult,
      settled: boolean,
      origin: "rpc" | "channel",
    ) => (updates = updates.then(() => acceptResult(result, settled, origin)));
    const acceptResult = async (
      result: ForkResult,
      settled: boolean,
      origin: "rpc" | "channel",
    ): Promise<ThreadState | undefined> => {
      const previouslySettled = Boolean(operation.settled);
      let verified = false;
      try {
        if (
          !result ||
          result.operationId !== operation.operationId ||
          result.parentConnectionId !== operation.connectionId ||
          result.parentSessionId !== operation.parentSessionId ||
          result.cwd !== parent.cwd ||
          !sameHistoryForkPoint(result.historyPoint, operation.historyPoint) ||
          !["ready", "created_unavailable", "unknown", "rejected"].includes(
            result.status,
          ) ||
          typeof result.indexed !== "boolean" ||
          typeof result.sourceReleased !== "boolean" ||
          (result.childSessionId != null &&
            (!validForkId(result.childSessionId) ||
              result.childSessionId === parent.nativeSessionId ||
              (operation.childSessionId &&
                result.childSessionId !== operation.childSessionId)))
        )
          throw new Error("invalid fork receipt");
        verified = true;
        if (validForkId(result.childSessionId))
          operation.childSessionId = result.childSessionId;
        operation.indexed ||= result.indexed;
        // Terminality is tied to this operation, not IPC arrival order. Late
        // metadata may recover a known ID after process exit, but an older
        // unknown snapshot cannot undo a final failure or completed handoff.
        if (previouslySettled)
          return operation.childKey
            ? this.ports.thread(operation.childKey)
            : undefined;
        operation.sourceReleased ||= result.sourceReleased;
        operation.reason = result.reason ?? undefined;
        if (settled) operation.settled = true;
        if (settled && result.reason === "owner_ended")
          operation.ownerEnded = true;
        if (result.status !== "ready") {
          // Progress does not turn an ordinarily pending request into a timeout.
          if (!(
            origin === "channel" &&
            !settled &&
            result.status === "unknown" &&
            result.reason == null &&
            operation.status === "pending"
          ))
            operation.status =
              result.status === "rejected" &&
              (!result.sourceReleased || operation.childSessionId)
                ? "unknown"
                : result.status;
          if (settled) inquiry.finish(true);
          return undefined;
        }
        if (!settled) return undefined;
        const opened = result.session;
        if (
          !current() ||
          !opened ||
          !result.sourceReleased ||
          !result.indexed ||
          !operation.childSessionId ||
          opened.nativeSessionId !== operation.childSessionId ||
          opened.cwd !== parent.cwd ||
          !validForkId(opened.connectionId) ||
          opened.connectionId === operation.connectionId ||
          opened.resumed !== true ||
          !sameConfigurationSnapshot(
            opened.service ?? null,
            parent.service ?? null,
          ) ||
          (opened.serviceContext ?? undefined) !== parent.serviceContext
        )
          throw new Error("incomplete independent fork receipt");
        await replay.waitForReady(true);
        const key = `${parent.agentId}:${opened.cwd}:${opened.nativeSessionId}`;
        if (!current() || this.ports.thread(key))
          throw new Error("fork target already present");
        await this.ports.refreshIndex();
        if (!current() || this.ports.thread(key))
          throw new Error("fork owner changed");
        const state = replay.accept(
          opened,
          this.ports.rows().find((row) => row.id === key)?.title,
        );
        this.ports.install(state, channel, replay.acceptedPermissionChanges);
        boundKey = key;
        transferOwner();
        inquiry.handoffPermissions(
          state,
          () =>
            this.ports.thread(key) === state &&
            this.ports.ownsChannel(key, channel),
          () => this.ports.emit(key),
        );
        inquiry.finish();
        operation.status = "ready";
        operation.childKey = key;
        this.ports.emit(key);
        return state;
      } catch (error) {
        if (previouslySettled) return undefined;
        operation.deliveryError = error;
        operation.status = operation.childSessionId
          ? "created_unavailable"
          : "unknown";
        operation.reason = "delivery_failed";
        if (settled && verified) inquiry.finish(true);
        return undefined;
      } finally {
        // A verified terminal result cannot acquire a child view later. Keep
        // receipt metadata observable, but retire its unconsumed body owner.
        if (settled && verified && !boundKey) {
          receivingReplay = false;
          replay.clear();
        }
        if (settled && verified) historyReads.finish(readKey, admission);
        if (
          settled &&
          verified &&
          this.requests.get(parent.key)?.operationId === operation.operationId
        )
          this.requests.delete(parent.key);
        this.ports.emit(parent.key);
        void this.ports.refreshIndex();
      }
    };
    try {
      await draftPersistence.flush();
      if (
        !current() ||
        forkBlockReason(
          { ...parent, forkOperation: undefined },
          operation.historyPoint,
        ) ||
        !sameConfigurationSnapshot(baseline, {
          check: parent.configCheck,
          options: parent.configOptions,
          service: parent.service,
          serviceContext: parent.serviceContext,
        })
      ) {
        operation.status = "rejected";
        operation.settled = true;
        operation.sourceReleased = true;
        operation.reason = "not_dispatched";
        inquiry.finish(true);
        return undefined;
      }
      dispatched = true;
      admission?.dispatch();
      const result = await invoke<ForkResult>("session_fork_current", {
        agentId: parent.agentId,
        cwd: parent.cwd,
        parentSessionId: operation.parentSessionId,
        connectionId: operation.connectionId,
        operationId: operation.operationId,
        ...(operation.historyPoint
          ? { historyPoint: operation.historyPoint }
          : {}),
        openToken,
        admissionChannel: admission?.channel,
        channel,
      });
      return await queueResult(
        result,
        result?.status === "ready" ||
          result?.status === "rejected" ||
          (result?.status === "created_unavailable" &&
            result.sourceReleased === true),
        "rpc",
      );
    } catch {
      if (!operation.settled && operation.status !== "ready") {
        operation.status = !dispatched
          ? "rejected"
          : operation.childSessionId
            ? "created_unavailable"
            : "unknown";
        if (!dispatched) {
          operation.sourceReleased = true;
          operation.settled = true;
          inquiry.finish(true);
        }
        operation.reason = dispatched ? "delivery_failed" : "not_dispatched";
      }
      return undefined;
    } finally {
      if (!dispatched) {
        transferOwner();
        channel.dispose();
        replay.clear();
        historyReads.finish(readKey, admission);
      }
      this.ports.emit(parent.key);
      void this.ports.refreshIndex();
    }
  }
}
