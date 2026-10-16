import { Channel, invoke } from "@tauri-apps/api/core";
import {
  configurationInputBusy,
  sameConfigurationSnapshot,
} from "./config_check";
import { draftPersistence } from "./drafts";
import { finishHistoryPrefix, HistoryReplayBuffer } from "./history_replay";
import { openingInquiries } from "./opening_inquiries";
import { configChangeBusy } from "./protected_config";
import { openedThreadState } from "./session_open_state";
import { requireReadableHistory } from "./session_recovery";
import { retireForkControlOwner, validForkId } from "./session_fork_activity";
import type { ForkOperation, ForkResult } from "./session_fork_types";
import { SESSION_FORK_STRINGS as S } from "./session_fork_strings";
import type { ThreadState } from "./session_types";
import type { IndexRow } from "./sessions";

export function forkBlockReason(thread: ThreadState): string | undefined {
  if (!thread.sessionOperations?.forkCurrentContext) return S.unsupported;
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
  install(state: ThreadState, channel: Channel<unknown>): void;
  ownsChannel(key: string, channel: Channel<unknown>): boolean;
  apply(key: string, event: unknown, live?: boolean): void;
  emit(key?: string): void;
  refreshIndex(): Promise<void>;
}

/** Coordinates delivery only; the backend owns the single official fork and
 * process handoff. A rejected/unknown IPC call never triggers a second fork. */
export class SessionForks {
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
    retireForkControlOwner(parent);
    parent.forkOperation = undefined;
    this.ports.emit(key);
    return true;
  }

  start(key: string): Promise<ThreadState | undefined> {
    const active = this.requests.get(key);
    if (active) return active.promise;
    const parent = this.ports.thread(key);
    if (!parent || forkBlockReason(parent)) return Promise.resolve(undefined);
    const operation: ForkOperation = {
      operationId: crypto.randomUUID(),
      connectionId: parent.connectionId!,
      parentSessionId: parent.nativeSessionId,
      status: "pending",
      sourceReleased: false,
      indexed: false,
    };
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
    const channel = new Channel<unknown>();
    const buffered = new HistoryReplayBuffer();
    const openToken = crypto.randomUUID();
    const inquiry = openingInquiries.begin(`fork:${operation.operationId}`, {
      agentId: parent.agentId,
      cwd: parent.cwd,
      inquiryCurrent: current,
    });
    let dispatched = false;
    let boundKey: string | undefined;
    let replayLost = false;
    let wake: (() => void) | undefined;
    channel.onmessage = (event) => {
      const received = event as { kind?: unknown; openToken?: unknown } | null;
      if (received?.kind === "forkSourceEvent") {
        const source = event as {
          operationId?: unknown;
          childSessionId?: unknown;
          event?: unknown;
        };
        if (source.operationId !== operation.operationId) return;
        const inner = source.event as Record<string, unknown> | null;
        if (!inner || typeof inner !== "object") return;
        if (source.childSessionId === null) {
          // Before fork returns an ID, reverse requests belong to its actual
          // request scope on the parent connection, not to an invented child.
          if (inner.kind === "elicitation") {
            const owner = inner.owner as Record<string, unknown> | null;
            if (
              !owner ||
              owner.connectionId !== operation.connectionId ||
              !(
                owner.sessionId === operation.parentSessionId ||
                (owner.sessionId === undefined && validForkId(owner.requestId))
              )
            )
              return;
          }
          inquiry.receive(inner);
        } else if (
          validForkId(source.childSessionId) &&
          (!operation.childSessionId ||
            operation.childSessionId === source.childSessionId)
        )
          inquiry.receive(inner);
        return;
      }
      if (received?.kind === "forkResult") {
        const delivered = event as {
          operationId?: unknown;
          result?: ForkResult;
          settled?: unknown;
        };
        if (
          delivered.operationId === operation.operationId &&
          delivered.result &&
          typeof delivered.settled === "boolean"
        )
          void queueResult(delivered.result, delivered.settled, "channel");
        return;
      }
      if (boundKey) {
        if (this.ports.ownsChannel(boundKey, channel))
          this.ports.apply(boundKey, event);
        return;
      }
      if (inquiry.receive(event)) return;
      if (received?.kind === "session_history_complete") {
        if (received.openToken === openToken) {
          buffered.mark(openToken);
          wake?.();
        }
      } else {
        buffered.push(event);
        if (received?.kind === "connectionLost") {
          replayLost = true;
          wake?.();
        }
      }
    };
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
        if (!buffered.complete(openToken) && !replayLost) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        wake = undefined;
        requireReadableHistory(
          parent.agentId,
          opened,
          buffered.prefix(openToken),
          buffered.complete(openToken),
          replayLost,
        );
        const key = `${parent.agentId}:${opened.cwd}:${opened.nativeSessionId}`;
        if (!current() || this.ports.thread(key))
          throw new Error("fork target already present");
        await this.ports.refreshIndex();
        if (!current() || this.ports.thread(key))
          throw new Error("fork owner changed");
        const state = openedThreadState(
          {
            agentId: parent.agentId,
            cwd: parent.cwd,
            nativeSessionId: opened.nativeSessionId,
          },
          opened,
          this.ports.rows().find((row) => row.id === key)?.title,
        );
        this.ports.install(state, channel);
        boundKey = key;
        const { prefix, following } = buffered.take(openToken);
        for (const event of prefix) this.ports.apply(key, event, false);
        finishHistoryPrefix(state);
        for (const event of following) this.ports.apply(key, event);
        inquiry.finish();
        operation.status = "ready";
        operation.childKey = key;
        this.ports.emit(key);
        return state;
      } catch {
        if (previouslySettled) return undefined;
        operation.status = operation.childSessionId
          ? "created_unavailable"
          : "unknown";
        operation.reason = "delivery_failed";
        if (settled && verified) inquiry.finish(true);
        return undefined;
      } finally {
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
        forkBlockReason({ ...parent, forkOperation: undefined }) ||
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
      const result = await invoke<ForkResult>("session_fork_current", {
        agentId: parent.agentId,
        cwd: parent.cwd,
        parentSessionId: operation.parentSessionId,
        connectionId: operation.connectionId,
        operationId: operation.operationId,
        openToken,
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
      this.ports.emit(parent.key);
      void this.ports.refreshIndex();
    }
  }
}
