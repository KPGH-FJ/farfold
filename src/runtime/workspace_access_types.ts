/** Reviewed supplementary read capability, separate from protocol capabilities. */
export interface WorkspaceAccessCapability {
  statusQuery: true;
  provenance: "reviewed-official-supplement";
}

export type WorkspaceAccessStatus = "trusted" | "session" | "untrusted";
export type WorkspaceAccessDecision = "trust_cwd" | "trust_repo" | "decline";
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
  return { statusQuery: true, provenance: "reviewed-official-supplement" };
}
