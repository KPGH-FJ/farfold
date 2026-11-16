import { invoke } from "@tauri-apps/api/core";
import { configChangeBusy } from "./protected_config";
import { configurationInputBusy } from "./config_check";
import { hasSessionToolChange } from "./session_tool_change_guard";
import type { ThreadState } from "./session_types";
import {
  parseToolRecoveryConfirmation,
  parseToolRecoveryInspection,
  type ToolRecoveryInspection,
  type ToolRecoveryTarget,
  type ToolRecoveryResolution,
} from "./session_tool_recovery_types";

export interface ToolRecoveryPort {
  inspect(target: ToolRecoveryTarget): Promise<unknown>;
  confirm(
    target: ToolRecoveryTarget,
    reviewId: string,
    connectionId: string,
    resolution: ToolRecoveryResolution,
  ): Promise<unknown>;
}
const port: ToolRecoveryPort = {
  inspect: (target) => invoke("session_tool_recovery_inspect", { target }),
  confirm: (target, reviewId, connectionId, resolution) =>
    invoke("session_tool_recovery_confirm", {
      target,
      reviewId,
      connectionId,
      resolution,
    }),
};
export interface ToolRecoverySnapshot {
  phase: "idle" | "inspecting" | "review" | "confirming" | "resolved" | "error";
  inspection: ToolRecoveryInspection | null;
  error: "failed" | "invalidResponse" | "timeout" | null;
  confirmationUnresolved: boolean;
}
const source = (s: ThreadState) =>
  JSON.stringify([
    s.agentId,
    s.cwd,
    s.nativeSessionId,
    s.serviceContext ?? null,
    s.service ?? null,
  ]);

/** A read/review owner; dismissed views do not cancel or repeat a native check. */
export class SessionToolRecoveryController {
  private snapshot: ToolRecoverySnapshot = {
    phase: "idle",
    inspection: null,
    error: null,
    confirmationUnresolved: false,
  };
  private listeners = new Set<() => void>();
  private inFlight = false;
  private observation = 0;
  private stamp: string;
  private target: ToolRecoveryTarget;
  constructor(
    private owner: ThreadState,
    private current: () => ThreadState | undefined,
    private resolved: (operationId: string) => boolean,
    private io: ToolRecoveryPort = port,
    private waitMs = 15000,
  ) {
    this.stamp = source(owner);
    this.target = {
      agentId: owner.agentId,
      cwd: owner.cwd,
      sessionId: owner.nativeSessionId,
    };
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = () => this.snapshot;
  isCurrent() {
    return this.current() === this.owner && source(this.owner) === this.stamp;
  }
  private publish(update: Partial<ToolRecoverySnapshot>) {
    if (!this.isCurrent()) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of [...this.listeners]) listener();
  }
  get blocked() {
    return (
      !this.isCurrent() ||
      this.inFlight ||
      configurationInputBusy(this.owner) ||
      configChangeBusy({
        ...this.owner,
        // These are the exact failed-open facts this explicit recheck handles.
        // The backend independently checks real work before touching its route.
        configuring:
          this.owner.configuring && !hasSessionToolChange(this.owner),
        connectionLost: false,
        openError: null,
      })
    );
  }
  private run(action: (current: () => boolean) => Promise<void>) {
    const observation = ++this.observation;
    const current = () => this.isCurrent() && this.observation === observation;
    this.inFlight = true;
    const timer = setTimeout(() => {
      if (!current()) return;
      // This ends only our wait. A new explicit check uses the same native
      // target/review; the backend retains and deduplicates the actual job.
      this.inFlight = false;
      this.publish({ phase: "error", error: "timeout" });
    }, this.waitMs);
    void action(current)
      .catch((error: unknown) => {
        if (!current()) return;
        const changed = error === "SESSION_TOOL_RECOVERY_REVIEW_CHANGED";
        this.publish({
          phase: "error",
          ...(changed
            ? { confirmationUnresolved: false, inspection: null }
            : {}),
          error:
            error instanceof Error && error.message === "invalidResponse"
              ? "invalidResponse"
              : "failed",
        });
      })
      .finally(() => {
        clearTimeout(timer);
        if (!current()) return;
        this.inFlight = false;
        this.publish({});
      });
  }
  inspect(): boolean {
    if (
      this.blocked ||
      this.snapshot.confirmationUnresolved ||
      !this.owner.sessionToolRecoveryRequired
    )
      return false;
    this.publish({ phase: "inspecting", error: null, inspection: null });
    this.run(async (current) => {
      const result = parseToolRecoveryInspection(
        await this.io.inspect(this.target),
        this.target,
      );
      if (!current()) return;
      this.publish({ phase: "review", error: null, inspection: result });
    });
    return true;
  }
  confirm(): boolean {
    const reviewed = this.snapshot.inspection;
    if (
      this.blocked ||
      !(
        this.snapshot.phase === "review" || this.snapshot.confirmationUnresolved
      ) ||
      !reviewed?.canConfirm ||
      !reviewed.reviewId ||
      !reviewed.connectionId ||
      !reviewed.resolution
    )
      return false;
    this.publish({
      phase: "confirming",
      error: null,
      confirmationUnresolved: true,
    });
    this.run(async (current) => {
      const result = parseToolRecoveryConfirmation(
        await this.io.confirm(
          this.target,
          reviewed.reviewId!,
          reviewed.connectionId!,
          reviewed.resolution!,
        ),
        reviewed,
      );
      if (!current()) return;
      if (!this.resolved(result.operationId))
        throw new Error("invalidResponse");
      this.publish({
        phase: "resolved",
        error: null,
        confirmationUnresolved: false,
      });
    });
    return true;
  }
}
