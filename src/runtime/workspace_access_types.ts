/** Reviewed supplementary read capability, separate from protocol capabilities. */
export interface WorkspaceAccessCapability {
  statusQuery: true;
  decisionManagement?: true;
  provenance: "reviewed-official-supplement";
}

export type WorkspaceAccessStatus = "trusted" | "session" | "untrusted";
export type WorkspaceAccessDecision = "trust_cwd" | "trust_repo" | "decline";
export type WorkspaceAccessTarget = {
  agentId: string;
  cwd: string;
  sessionId: string;
  connectionId: string;
};
export interface WorkspaceAccessResult {
  connectionId: string;
  nativeSessionId: string;
  cwd: string;
  status: WorkspaceAccessStatus;
  details: {
    cwd: string;
    repoRoot: string | null;
    repoScopeVerified: boolean;
    offeredDecisions: WorkspaceAccessDecision[] | null;
  } | null;
}
export type WorkspaceAccessScope = NonNullable<
  WorkspaceAccessResult["details"]
>;

export function workspaceAccessResultFor(
  value: unknown,
  target: WorkspaceAccessTarget,
): WorkspaceAccessResult | null {
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const nonempty = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && !v.includes("\0");
  if (
    !object(value) ||
    value.connectionId !== target.connectionId ||
    value.nativeSessionId !== target.sessionId ||
    value.cwd !== target.cwd ||
    typeof value.status !== "string" ||
    !["trusted", "session", "untrusted"].includes(value.status)
  )
    return null;
  let details: WorkspaceAccessScope | null = null;
  if (value.details !== null && value.details !== undefined) {
    const d = value.details;
    if (
      !object(d) ||
      d.cwd !== target.cwd ||
      typeof d.repoScopeVerified !== "boolean" ||
      !(
        (d.repoRoot === null && !d.repoScopeVerified) ||
        (nonempty(d.repoRoot) && d.repoScopeVerified)
      ) ||
      !(
        d.offeredDecisions === null ||
        d.offeredDecisions === undefined ||
        (Array.isArray(d.offeredDecisions) &&
          d.offeredDecisions.every((v) =>
            ["trust_cwd", "trust_repo", "decline"].includes(v),
          ))
      )
    )
      return null;
    details = {
      cwd: target.cwd,
      repoRoot: d.repoRoot as string | null,
      repoScopeVerified: d.repoScopeVerified,
      offeredDecisions:
        (d.offeredDecisions as WorkspaceAccessDecision[] | null | undefined) ??
        null,
    };
  }
  return {
    connectionId: target.connectionId,
    nativeSessionId: target.sessionId,
    cwd: target.cwd,
    status: value.status as WorkspaceAccessResult["status"],
    details,
  };
}

export function workspaceAccessCapability(
  value: unknown,
): WorkspaceAccessCapability | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as WorkspaceAccessCapability).statusQuery !== true ||
    (value as WorkspaceAccessCapability).provenance !==
      "reviewed-official-supplement"
  )
    return null;
  return {
    statusQuery: true,
    ...((value as WorkspaceAccessCapability).decisionManagement === true
      ? { decisionManagement: true as const }
      : {}),
    provenance: "reviewed-official-supplement",
  };
}
