import { invoke } from "@tauri-apps/api/core";
import { sameConfigurationSnapshot } from "./config_check";
import { configChangeBusy } from "./protected_config";
import type { ThreadState } from "./session_types";
import type { WorkspaceAccessStatusController } from "./workspace_access_status";
import {
  workspaceAccessCapability,
  workspaceAccessResultFor,
  type WorkspaceAccessDecision,
  type WorkspaceAccessResult,
  type WorkspaceAccessScope,
  type WorkspaceAccessTarget,
} from "./workspace_access_types";
import { WORKSPACE_ACCESS as S } from "./workspace_access_strings";

export type WorkspaceDecisionError = {
  code: keyof typeof S.decisionErrors;
  effect: "notDispatched" | "unconfirmed";
};
export function workspaceDecisionError(error: unknown): WorkspaceDecisionError {
  const value = error as Partial<WorkspaceDecisionError> | null;
  const known =
    value &&
    typeof value === "object" &&
    typeof value.code === "string" &&
    Object.hasOwn(S.decisionErrors, value.code) &&
    ["notDispatched", "unconfirmed"].includes(value.effect ?? "");
  return {
    code: known ? value.code! : "queryFailed",
    effect:
      known && value.effect === "notDispatched"
        ? "notDispatched"
        : "unconfirmed",
  };
}
const rejected = (
  code: WorkspaceDecisionError["code"],
): WorkspaceDecisionError => ({ code, effect: "notDispatched" });
const sourceOf = (s: ThreadState) =>
  JSON.stringify([
    s.serviceContext ?? null,
    s.service?.id ?? null,
    s.service?.fingerprint ?? null,
  ]);
function decisionBlocked(s: ThreadState): boolean {
  return Boolean(
    configChangeBusy(s) ||
    s.configError ||
    s.modelDrift ||
    (s.configCheck && s.configCheck.status !== "ready") ||
    s.permissionState === "unknown" ||
    (s.permissionConfigId && s.permissionState !== "ready"),
  );
}
export interface PreparedWorkspaceDecision {
  owner: ThreadState;
  key: string;
  target: WorkspaceAccessTarget;
  source: string;
  decision: WorkspaceAccessDecision;
  expectedScope: WorkspaceAccessScope;
}

/** Validate the explicit review before the store takes its existing configuring guard. */
export function prepareWorkspaceDecision(
  owner: ThreadState,
  decision: WorkspaceAccessDecision,
  expectedScope: WorkspaceAccessScope,
): PreparedWorkspaceDecision {
  if (!workspaceAccessCapability(owner.workspaceAccess)?.decisionManagement)
    throw rejected("unavailable");
  if (decisionBlocked(owner)) throw rejected("busy");
  const target = {
    agentId: owner.agentId,
    cwd: owner.cwd,
    sessionId: owner.nativeSessionId,
    connectionId: owner.connectionId ?? "",
  };
  if (
    !Object.values(target).every(
      (v) => typeof v === "string" && v.length > 0 && !v.includes("\0"),
    )
  )
    throw rejected("changed");
  const checked = workspaceAccessResultFor(
    {
      ...target,
      nativeSessionId: target.sessionId,
      status: "untrusted",
      details: expectedScope,
    },
    target,
  )?.details;
  if (!checked?.offeredDecisions?.includes(decision))
    throw rejected("notOffered");
  if (
    decision === "trust_repo" &&
    (!checked.repoScopeVerified || !checked.repoRoot)
  )
    throw rejected("scopeChanged");
  return {
    owner,
    key: owner.key,
    target,
    source: sourceOf(owner),
    decision,
    expectedScope: {
      ...checked,
      offeredDecisions: [...checked.offeredDecisions],
    },
  };
}
export function workspaceDecisionOwns(
  request: PreparedWorkspaceDecision,
  current: ThreadState | undefined,
): boolean {
  return Boolean(
    current &&
    current === request.owner &&
    current.key === request.key &&
    current.agentId === request.target.agentId &&
    current.cwd === request.target.cwd &&
    current.nativeSessionId === request.target.sessionId &&
    current.connectionId === request.target.connectionId &&
    sourceOf(current) === request.source,
  );
}
/** Called only by the store; component disposal cannot end this write. */
export async function runWorkspaceDecision(
  request: PreparedWorkspaceDecision,
  current: () => ThreadState | undefined,
): Promise<WorkspaceAccessResult> {
  if (!workspaceDecisionOwns(request, current())) throw rejected("changed");
  if (
    !workspaceAccessCapability(request.owner.workspaceAccess)
      ?.decisionManagement
  )
    throw rejected("unavailable");
  if (decisionBlocked({ ...request.owner, configuring: false }))
    throw rejected("busy");
  try {
    const value = await invoke("session_workspace_access_decide", {
      ...request.target,
      decision: request.decision,
      expectedScope: request.expectedScope,
    });
    if (!workspaceDecisionOwns(request, current()))
      throw { code: "changed", effect: "unconfirmed" };
    const result = workspaceAccessResultFor(value, request.target);
    if (!result) throw { code: "invalidResponse", effect: "unconfirmed" };
    return result;
  } catch (error) {
    throw workspaceDecisionError(error);
  }
}

export type WorkspaceDecisionSnapshot =
  | { phase: "idle" }
  | {
      phase: "review";
      decision: WorkspaceAccessDecision;
      scope: WorkspaceAccessScope;
    }
  | {
      phase: "submitting";
      decision: WorkspaceAccessDecision;
      scope: WorkspaceAccessScope;
    }
  | { phase: "reported"; result: WorkspaceAccessResult }
  | { phase: "error"; error: WorkspaceDecisionError };

/** Ephemeral review/display only. The injected store operation owns the mutation. */
export class WorkspaceAccessDecisionController {
  private snapshot: WorkspaceDecisionSnapshot = { phase: "idle" };
  private listeners = new Set<() => void>();
  private reviewedResult: WorkspaceAccessResult | null = null;
  private request: object | null = null;
  private retired = false;
  constructor(
    private readonly owner: ThreadState | null,
    private readonly status: WorkspaceAccessStatusController,
    private readonly decide: (
      decision: WorkspaceAccessDecision,
      scope: WorkspaceAccessScope,
    ) => Promise<WorkspaceAccessResult>,
  ) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = () => this.snapshot;
  private publish(value: WorkspaceDecisionSnapshot) {
    this.snapshot = value;
    for (const listener of this.listeners) listener();
  }
  get choices(): WorkspaceAccessDecision[] {
    if (
      this.retired ||
      !this.status.isCurrent() ||
      !workspaceAccessCapability(this.owner?.workspaceAccess)
        ?.decisionManagement
    )
      return [];
    const report = this.status.getSnapshot();
    if (report.phase !== "ready" || !report.result.details?.offeredDecisions)
      return [];
    const scope = report.result.details;
    return [...new Set(scope.offeredDecisions)].filter(
      (choice) =>
        choice !== "trust_repo" || (scope.repoScopeVerified && scope.repoRoot),
    );
  }
  get blocked(): boolean {
    return Boolean(
      this.retired ||
      this.request ||
      this.status.blockedReason ||
      (this.owner && decisionBlocked(this.owner)),
    );
  }
  review(decision: WorkspaceAccessDecision): boolean {
    if (this.blocked || !this.choices.includes(decision)) return false;
    const report = this.status.getSnapshot();
    if (report.phase !== "ready" || !report.result.details) return false;
    this.reviewedResult = report.result;
    this.publish({
      phase: "review",
      decision,
      scope: {
        ...report.result.details,
        offeredDecisions: [...report.result.details.offeredDecisions!],
      },
    });
    return true;
  }
  async confirm(): Promise<boolean> {
    const snapshot = this.snapshot;
    if (snapshot.phase !== "review" || this.blocked) return false;
    const report = this.status.getSnapshot();
    if (
      report.phase !== "ready" ||
      report.result !== this.reviewedResult ||
      !sameConfigurationSnapshot(report.result.details, snapshot.scope) ||
      !this.choices.includes(snapshot.decision)
    ) {
      this.publish({ phase: "error", error: rejected("scopeChanged") });
      return false;
    }
    const request = (this.request = {});
    this.publish({ ...snapshot, phase: "submitting" });
    try {
      const result = await this.decide(snapshot.decision, snapshot.scope);
      if (this.request !== request || this.retired || !this.status.isCurrent())
        return false;
      this.publish({ phase: "reported", result });
      return true;
    } catch (error) {
      if (this.request === request && !this.retired && this.status.isCurrent())
        this.publish({ phase: "error", error: workspaceDecisionError(error) });
      return false;
    } finally {
      if (this.request === request) this.request = null;
    }
  }
  activate() {
    this.retired = false;
  }
  dismiss() {
    this.request = null;
    this.reviewedResult = null;
    this.publish({ phase: "idle" });
  }
  dispose() {
    this.retired = true;
    this.request = null;
    this.reviewedResult = null;
    this.snapshot = { phase: "idle" };
    this.listeners.clear();
  }
}
