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
