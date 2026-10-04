import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type {
  BrowserWorkspaceInvoke,
  BrowserWorkspaceState,
} from "./browser_workspace";
import { BROWSER_SHARING_STRINGS as S } from "./browser_sharing_strings";
import { browserSharingAttention } from "./browser_sharing_attention";

export interface BrowserSharingTarget {
  agentId: string;
  cwd: string;
  nativeSessionId: string;
}

export interface BrowserSharingScope {
  taskKey: string;
  target: BrowserSharingTarget;
}

export interface BrowserReadPendingRequest {
  requestId: string;
  taskKey: string;
  label: string;
  url: string;
  pageRevision: number;
  phase: "awaiting_permission";
}

export interface BrowserShareInfo {
  taskKey: string;
  label: string;
  agentId: string;
  phase:
    | "unavailable"
    | "preparing"
    | "unshared"
    | "shared"
    | "stopping"
    | "stop_failed";
  revision: number;
  reason: string | null;
  pendingRequest: BrowserReadPendingRequest | null;
}

type ScopeInput = BrowserSharingScope & { label: string };
export interface BrowserSharingClient {
  status(input: ScopeInput): Promise<BrowserShareInfo>;
  allow(
    input: ScopeInput & { expectedPageRevision: number },
  ): Promise<BrowserShareInfo>;
  stop(
    input: ScopeInput & { expectedRevision: number },
  ): Promise<BrowserShareInfo>;
  respond(
    input: ScopeInput & { requestId: string; allow: boolean },
  ): Promise<BrowserShareInfo>;
  /** Subscribe to the trusted main view's event, passing its taskKey only. */
  listenChanged(listener: (taskKey: string) => void): Promise<() => void>;
}

export function createBrowserSharingClient(
  invoke: BrowserWorkspaceInvoke,
  listenChanged: BrowserSharingClient["listenChanged"],
): BrowserSharingClient {
  return {
    status: (input) => invoke("browser_share_status", { ...input }),
    allow: (input) => invoke("browser_share_allow", { ...input }),
    stop: (input) => invoke("browser_share_stop", { ...input }),
    respond: (input) => invoke("browser_share_respond", { ...input }),
    listenChanged,
  };
}

export type BrowserSharingOperation = "allow" | "deny" | "stop" | null;
export type BrowserSharingQueryState =
  "no_session" | "inactive" | "disconnected" | "checking" | "ready" | "failed";

export interface BrowserSharingSnapshot {
  /** Query lifecycle, independent from whether the tool or page is available. */
  queryState: BrowserSharingQueryState;
  info: BrowserShareInfo | null;
  pendingRequest: BrowserReadPendingRequest | null;
  operation: BrowserSharingOperation;
  error: string;
  notice: string;
  ready: boolean;
}
export interface BrowserSharingModel extends BrowserSharingSnapshot {
  refresh(): Promise<void>;
  allow(): Promise<void>;
  stop(): Promise<void>;
  respond(requestId: string, allow: boolean): Promise<void>;
}

const EMPTY: BrowserSharingSnapshot = {
  queryState: "checking",
  info: null,
  pendingRequest: null,
  operation: null,
  error: "",
  notice: "",
  ready: false,
};
const noop = async () => {};
const noSubscribe = () => () => {};
const NO_SESSION: BrowserSharingSnapshot = {
  ...EMPTY,
  queryState: "no_session",
};
const INACTIVE: BrowserSharingSnapshot = { ...EMPTY, queryState: "inactive" };
const DISCONNECTED: BrowserSharingSnapshot = {
  ...EMPTY,
  queryState: "disconnected",
};

/** No query means no loading indicator. No Agent-name inference is involved. */
export function browserSharingIdleSnapshot(
  queryable: boolean,
  active: boolean,
  disconnected: boolean,
): BrowserSharingSnapshot {
  if (!queryable) return NO_SESSION;
  if (disconnected) return DISCONNECTED;
  return active ? EMPTY : INACTIVE;
}

/** Transient permission state only; it never sends prompts or stores page text. */
export class BrowserSharingController {
  private snapshot: BrowserSharingSnapshot = EMPTY;
  private readonly attentionOwner = {};
  private active = true;
  private listeners = new Set<() => void>();
  private page: BrowserWorkspaceState | null = null;
  private unlisten: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private lifetime = 0;
  private lastRevision = -1;
  private sequence = 0;
  private refreshNeeded = false;

  constructor(
    readonly client: BrowserSharingClient,
    readonly scope: BrowserSharingScope,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<BrowserSharingSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    browserSharingAttention.update(
      this.attentionOwner,
      this.scope.taskKey,
      this.snapshot.pendingRequest?.requestId ?? null,
    );
    this.listeners.forEach((listener) => listener());
  }
  /** Inactive views keep observing cancellation/stop receipts but cannot act. */
  setActive(active: boolean) {
    this.active = active;
  }
  private input(label = this.page?.label ?? ""): ScopeInput {
    return { ...this.scope, label };
  }
  private pending(
    info: BrowserShareInfo | null,
  ): BrowserReadPendingRequest | null {
    const pending = info?.pendingRequest;
    if (
      !pending ||
      pending.phase !== "awaiting_permission" ||
      pending.taskKey !== this.scope.taskKey ||
      !pending.requestId ||
      !pending.label
    )
      return null;
    if (
      this.page &&
      (this.page.taskKey !== pending.taskKey ||
        this.page.label !== pending.label ||
        this.page.revision !== pending.pageRevision ||
        this.page.phase !== "ready")
    )
      return null;
    return pending;
  }
  private accept(
    info: BrowserShareInfo,
    sequence: number,
    queried = false,
  ): boolean {
    if (
      this.disposed ||
      sequence !== this.sequence ||
      info.taskKey !== this.scope.taskKey ||
      info.agentId !== this.scope.target.agentId ||
      (!queried && info.revision < this.lastRevision) ||
      (this.page && info.label !== this.page.label)
    )
      return false;
    this.lastRevision = info.revision;
    const notice = this.snapshot.notice;
    this.publish({
      info,
      pendingRequest: this.pending(info),
      ready: true,
      queryState: "ready",
      error: "",
      notice:
        info.pendingRequest ||
        (notice === S.allowed && info.phase !== "shared") ||
        (notice === S.stopped && info.phase !== "unshared")
          ? ""
          : notice,
    });
    return true;
  }

  setPage(page: BrowserWorkspaceState | null) {
    if (page?.taskKey !== this.scope.taskKey) page = null;
    if (
      this.page?.label === page?.label &&
      this.page?.revision === page?.revision &&
      this.page?.phase === page?.phase
    )
      return;
    this.page = page;
    ++this.sequence;
    // Page changes invalidate visible grants immediately, before any asynchronous query.
    const stopping =
      this.snapshot.operation === "stop" ||
      this.snapshot.info?.phase === "stopping" ||
      this.snapshot.info?.phase === "stop_failed";
    this.publish({
      info: stopping ? this.snapshot.info : null,
      pendingRequest: null,
      notice: "",
      ready: false,
      queryState: "checking",
      error: "",
    });
    if (this.unlisten) void this.query();
  }

  start(): Promise<void> {
    if (this.unlisten) return Promise.resolve();
    if (this.starting) return this.starting;
    this.disposed = false;
    const lifetime = ++this.lifetime;
    this.publish({ queryState: "checking", error: "" });
    this.starting = (async () => {
      try {
        const stop = await this.client.listenChanged((taskKey) => {
          if (
            taskKey !== this.scope.taskKey ||
            this.disposed ||
            lifetime !== this.lifetime
          )
            return;
          if (!this.unlisten || this.snapshot.operation)
            this.refreshNeeded = true;
          else void this.query();
        });
        if (this.disposed || lifetime !== this.lifetime) {
          stop();
          return;
        }
        this.unlisten = stop;
        // The listener is established first, so a request cannot fall between query and listen.
        await this.query();
      } catch {
        if (lifetime === this.lifetime)
          this.publish({
            ...EMPTY,
            queryState: "failed",
            error: S.statusFailed,
          });
      } finally {
        if (lifetime === this.lifetime) this.starting = null;
      }
    })();
    return this.starting;
  }

  private async query() {
    if (this.disposed || !this.unlisten) return;
    if (this.snapshot.operation) {
      this.refreshNeeded = true;
      return;
    }
    this.refreshNeeded = false;
    const sequence = ++this.sequence;
    const lifetime = this.lifetime;
    this.publish({ queryState: "checking", ready: false, error: "" });
    try {
      // Status is authoritative for this exact target. A recreated tool can
      // restart its local revision, so only command replies require monotonicity.
      const accepted = this.accept(
        await this.client.status(this.input()),
        sequence,
        true,
      );
      if (
        !accepted &&
        !this.disposed &&
        sequence === this.sequence &&
        lifetime === this.lifetime
      )
        throw new Error("Mismatched browser status");
    } catch {
      if (sequence === this.sequence && lifetime === this.lifetime)
        this.publish({
          // A failed status lookup cannot turn an unconfirmed stop into no grant.
          info:
            this.snapshot.info?.phase === "stopping" ||
            this.snapshot.info?.phase === "stop_failed"
              ? this.snapshot.info
              : null,
          // Failure is not evidence that the last observed request ended.
          // Keep its identity as attention, but require a fresh status before acting.
          ready: false,
          queryState: "failed",
          notice: "",
          error: S.statusFailed,
        });
    }
  }

  refresh = async () => {
    if (!this.unlisten) await this.start();
    else await this.query();
  };

  private async run(
    operation: Exclude<BrowserSharingOperation, null>,
    action: () => Promise<BrowserShareInfo>,
    notice: string,
  ) {
    if (
      this.disposed ||
      !this.active ||
      !this.unlisten ||
      !this.snapshot.ready ||
      this.snapshot.operation
    )
      return;
    const sequence = ++this.sequence;
    const lifetime = this.lifetime;
    this.publish({ operation, error: "", notice: "" });
    let failed = false;
    try {
      const info = await action();
      if (this.accept(info, sequence))
        this.publish({
          notice:
            (operation === "allow" && info.phase !== "shared") ||
            (operation === "stop" && info.phase !== "unshared")
              ? ""
              : notice,
        });
      else if (
        !this.disposed &&
        sequence === this.sequence &&
        lifetime === this.lifetime
      )
        throw new Error("Mismatched browser operation response");
    } catch {
      failed = true;
      if (sequence === this.sequence)
        this.publish({
          error:
            operation === "stop"
              ? S.stopFailed
              : operation === "allow"
                ? S.allowFailed
                : S.responseFailed,
          // The reply may have been applied even when its response was lost.
          // Retain attention until a trusted status resolves the original request.
          ready: false,
          queryState: "failed",
        });
    } finally {
      if (lifetime !== this.lifetime) return;
      this.publish({ operation: null });
      if (this.refreshNeeded || sequence !== this.sequence) await this.query();
      // A failed command is not proof of failure or success. A fresh authoritative
      // query above can resolve it; never replace that result with an old error.
      if (
        failed &&
        !this.snapshot.error &&
        this.snapshot.queryState !== "ready"
      )
        this.publish({
          error: operation === "stop" ? S.stopFailed : S.responseFailed,
        });
    }
  }

  allow = async () => {
    const page = this.page;
    if (
      !page ||
      page.phase !== "ready" ||
      this.snapshot.info?.phase !== "unshared" ||
      this.snapshot.pendingRequest
    )
      return;
    await this.run(
      "allow",
      () =>
        this.client.allow({
          ...this.input(page.label),
          expectedPageRevision: page.revision,
        }),
      S.allowed,
    );
  };
  stop = async () => {
    const info = this.snapshot.info;
    if (!info || !["shared", "stop_failed"].includes(info.phase)) return;
    await this.run(
      "stop",
      () =>
        this.client.stop({
          ...this.input(info.label),
          expectedRevision: info.revision,
        }),
      S.stopped,
    );
  };
  respond = async (requestId: string, allow: boolean) => {
    const pending = this.snapshot.pendingRequest;
    if (!pending || pending.requestId !== requestId) return;
    await this.run(
      allow ? "allow" : "deny",
      () =>
        this.client.respond({
          ...this.input(pending.label),
          requestId,
          allow,
        }),
      allow ? S.allowed : S.denied,
    );
  };
  dispose() {
    browserSharingAttention.release(this.attentionOwner, this.scope.taskKey);
    this.disposed = true;
    ++this.lifetime;
    ++this.sequence;
    this.unlisten?.();
    this.unlisten = null;
    this.starting = null;
    this.snapshot = EMPTY;
  }
}

/** Hold this in the conversation, independent of whether its browser pane is visible. */
export function useBrowserSharing(
  scope: BrowserSharingScope | null,
  page: BrowserWorkspaceState | null,
  active: boolean,
  client: BrowserSharingClient,
  disconnected = false,
): BrowserSharingModel {
  const taskKey = scope?.taskKey;
  const agentId = scope?.target.agentId;
  const cwd = scope?.target.cwd;
  const nativeSessionId = scope?.target.nativeSessionId;
  const queryable = Boolean(taskKey && agentId && cwd && nativeSessionId);
  const controller = useMemo(
    () =>
      !disconnected && taskKey && agentId && cwd && nativeSessionId
        ? new BrowserSharingController(client, {
            taskKey,
            target: { agentId, cwd, nativeSessionId },
          })
        : null,
    [client, disconnected, taskKey, agentId, cwd, nativeSessionId],
  );
  useLayoutEffect(() => {
    controller?.setActive(active);
  }, [controller, active]);
  useLayoutEffect(() => {
    controller?.setPage(page);
  }, [controller, page]);
  useLayoutEffect(() => () => controller?.dispose(), [controller]);
  useEffect(() => {
    void controller?.start();
  }, [controller]);
  const idle = browserSharingIdleSnapshot(queryable, active, disconnected);
  const getIdle = () => idle;
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? getIdle,
    getIdle,
  );
  return {
    ...snapshot,
    queryState: controller && !active ? "inactive" : snapshot.queryState,
    ready: active && snapshot.ready,
    refresh: controller?.refresh ?? noop,
    allow: controller?.allow ?? noop,
    stop: controller?.stop ?? noop,
    respond: controller?.respond ?? noop,
  };
}
