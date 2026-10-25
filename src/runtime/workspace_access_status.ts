import { invoke } from "@tauri-apps/api/core";
import { configChangeBusy } from "./protected_config";
import type { ThreadState } from "./session_types";
import {
  workspaceAccessCapability,
  workspaceAccessResultFor,
  type WorkspaceAccessResult,
  type WorkspaceAccessTarget,
} from "./workspace_access_types";
import { WORKSPACE_ACCESS as S } from "./workspace_access_strings";

type Failure = keyof typeof S.errors;
export type WorkspaceAccessSnapshot =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; result: WorkspaceAccessResult }
  | { phase: "error"; code: Failure };
type Target = WorkspaceAccessTarget;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !v.includes("\0");

/** One transient read on an already prepared owner; no connection or draft creation. */
export class WorkspaceAccessStatusController {
  private snapshot: WorkspaceAccessSnapshot = { phase: "idle" };
  private listeners = new Set<() => void>();
  private request: object | null = null;
  private retired = false;
  private unavailable = false;
  private readonly target: Target;
  private readonly source: string;
  private readonly key: string;
  constructor(
    private readonly owner: ThreadState | null,
    private readonly current: () => ThreadState | undefined,
    private readonly query = (args: Target): Promise<unknown> =>
      invoke("session_workspace_access_status", args),
  ) {
    this.target = {
      agentId: owner?.agentId ?? "",
      cwd: owner?.cwd ?? "",
      sessionId: owner?.nativeSessionId ?? "",
      connectionId: owner?.connectionId ?? "",
    };
    this.source = this.sourceOf(owner);
    this.key = owner?.key ?? "";
  }
  private sourceOf(s: ThreadState | null | undefined) {
    return JSON.stringify([
      s?.serviceContext ?? null,
      s?.service?.id ?? null,
      s?.service?.fingerprint ?? null,
    ]);
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = () => this.snapshot;
  private publish(value: WorkspaceAccessSnapshot) {
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }
  readonly isCurrent = () => {
    const s = this.current();
    return Boolean(
      !this.retired &&
      s &&
      s === this.owner &&
      s.key === this.key &&
      s.agentId === this.target.agentId &&
      s.cwd === this.target.cwd &&
      s.nativeSessionId === this.target.sessionId &&
      s.connectionId === this.target.connectionId &&
      Object.values(this.target).every(nonempty) &&
      this.sourceOf(s) === this.source &&
      workspaceAccessCapability(s.workspaceAccess),
    );
  };
  get blockedReason(): string | null {
    if (!this.isCurrent()) return S.errors.changed;
    if (this.unavailable) return S.errors.unavailable;
    return configChangeBusy(this.owner!) ? S.errors.busy : null;
  }
  activate() {
    this.retired = false;
  }
  dismiss() {
    this.request = null;
    this.publish({ phase: "idle" });
  }
  dispose() {
    this.retired = true;
    this.request = null;
    this.snapshot = { phase: "idle" };
    this.listeners.clear();
  }
  async read(): Promise<boolean> {
    if (this.request || this.blockedReason) return false;
    const request = (this.request = {});
    this.publish({ phase: "loading" });
    try {
      const value = await this.query({ ...this.target });
      if (this.request !== request) return false;
      if (!this.isCurrent()) {
        this.dismiss();
        return false;
      }
      if (this.blockedReason) {
        this.publish({ phase: "error", code: "busy" });
        return false;
      }
      const result = workspaceAccessResultFor(value, this.target);
      this.publish(
        result
          ? { phase: "ready", result }
          : { phase: "error", code: "invalidResponse" },
      );
      return result !== null;
    } catch (error) {
      if (this.request !== request || !this.isCurrent()) return false;
      const code: Failure =
        object(error) &&
        typeof error.code === "string" &&
        Object.hasOwn(S.errors, error.code)
          ? (error.code as Failure)
          : "queryFailed";
      if (code === "unavailable") this.unavailable = true;
      this.publish({ phase: "error", code });
      return false;
    } finally {
      if (this.request === request) this.request = null;
    }
  }
}
