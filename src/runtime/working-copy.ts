import { invoke } from "@tauri-apps/api/core";

export type WorkingCopyChangeState =
  "clean" | "dirty" | "conflicted" | "not_git" | "unavailable";

export interface WorkingCopyGitStatus {
  state: WorkingCopyChangeState;
  stagedPathCount: number;
  unstagedPathCount: number;
  untrackedPathCount: number;
  conflictedPathCount: number;
}

export interface ManagedWorktreePreview {
  sourceWorkingCopyId: string;
  projectId: string;
  sourcePath: string;
  sourceBranchName: string | null;
  sourceHeadOid: string;
  sourceGitStatus: WorkingCopyGitStatus;
  branchName: string;
  workingCopyId: string;
  workingCopyPath: string;
  requiresLocalChangesChoice: boolean;
}

export interface ManagedWorktreeCreateResult {
  workingCopyId: string;
  projectId: string;
  workingCopyPath: string;
  branchName: string;
  sourceHeadOid: string;
  lifecycleState: "ready";
}

export type ManagedWorktreeState = "creating" | "ready" | "orphaned";
export type ManagedWorktreeRemovalState = "removing" | "removed" | "failed";

export interface WorkingCopyRecord {
  workingCopyId: string;
  projectId: string;
  canonicalPath: string;
  kind: "root" | "worktree";
  branchName: string | null;
  pathState:
    "ready" | "missing" | "not_directory" | "identity_mismatch" | "unavailable";
  gitStatus: WorkingCopyGitStatus;
  boundSessionCount: number;
  unarchivedSessionCount: number;
  createdAt: number;
  updatedAt: number;
  managedState: ManagedWorktreeState | null;
  managedSourceWorkingCopyId: string | null;
  managedSourceHeadOid: string | null;
  managedErrorCode: string | null;
  removalState: ManagedWorktreeRemovalState | null;
  removalErrorCode: string | null;
  removedAt: number | null;
}

export interface WorkingCopySnapshot {
  workingCopies: WorkingCopyRecord[];
  observedAt: number;
}

export type ManagedWorktreeRemovalBlocker =
  | "not_ready"
  | "removal_in_progress"
  | "already_removed"
  | "bound_sessions"
  | "path_unavailable"
  | "identity_mismatch"
  | "changes_present"
  | "git_unavailable";

export interface ManagedWorktreeRemovalPreview {
  workingCopyId: string;
  projectId: string;
  workingCopyPath: string;
  branchName: string;
  currentHeadOid: string | null;
  pathState: WorkingCopyRecord["pathState"];
  gitStatus: WorkingCopyGitStatus;
  boundSessionCount: number;
  priorRemovalState: ManagedWorktreeRemovalState | null;
  effects: {
    removesWorktreeDirectory: boolean;
    retainsBranch: boolean;
    retainsProject: boolean;
    retainsSourceWorkingCopy: boolean;
    deletesFarfoldSessions: boolean;
  };
  blockers: ManagedWorktreeRemovalBlocker[];
  executionEnabled: boolean;
  confirmationToken: string;
  previewedAt: number;
}

export interface ManagedWorktreeRemovalResult {
  workingCopyId: string;
  workingCopyPath: string;
  branchName: string;
  retainedBranch: boolean;
  lifecycleState: "removed";
  removedAt: number;
}

export function previewManagedWorktree(
  sourceWorkingCopyId: string,
  branchName: string,
): Promise<ManagedWorktreePreview> {
  return invoke("managed_worktree_creation_preview", {
    input: { sourceWorkingCopyId, branchName },
  });
}

export function createManagedWorktree(
  preview: ManagedWorktreePreview,
  localChangesChoice?: "use_head_only" | "cancel",
): Promise<ManagedWorktreeCreateResult> {
  return invoke("managed_worktree_create", {
    input: {
      preview,
      ...(localChangesChoice ? { localChangesChoice } : {}),
    },
  });
}

export function workingCopySnapshot(): Promise<WorkingCopySnapshot> {
  return invoke("working_copy_snapshot");
}

export function previewManagedWorktreeRemoval(
  workingCopyId: string,
): Promise<ManagedWorktreeRemovalPreview> {
  return invoke("managed_worktree_removal_preview", {
    input: { workingCopyId },
  });
}

export function removeManagedWorktree(
  preview: ManagedWorktreeRemovalPreview,
): Promise<ManagedWorktreeRemovalResult> {
  return invoke("managed_worktree_remove", {
    input: {
      workingCopyId: preview.workingCopyId,
      confirmWorkingCopyId: preview.workingCopyId,
      expectedConfirmationToken: preview.confirmationToken,
    },
  });
}
