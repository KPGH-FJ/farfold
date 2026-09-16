import { invoke } from "@tauri-apps/api/core";

export type TurnChangeProvenanceState =
  "capturing" | "available" | "project_level_only" | "failed" | "interrupted";

export type TurnChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export type TurnChangeFileState =
  | "text"
  | "binary"
  | "large"
  | "deleted"
  | "missing"
  | "not_regular"
  | "outside_working_copy"
  | "unknown";

export type TurnChangeCurrentPathState =
  | "matches_recorded_paths"
  | "changed_after_turn"
  | "unavailable"
  | "not_applicable";

export interface TurnChangePath {
  relativePath: string;
  previousPath: string | null;
  changeKind: TurnChangeKind;
  fileState: TurnChangeFileState;
}

export interface TurnChangeReview {
  turnId: string;
  farfoldSessionId: string;
  workingCopyId: string;
  runtimeProductId: string;
  provenanceState: TurnChangeProvenanceState;
  baselineHeadOid: string | null;
  terminalHeadOid: string | null;
  baselineClean: boolean;
  managedWorktree: boolean;
  changePathCount: number;
  terminalReason: string | null;
  startedAt: number;
  completedAt: number | null;
  reviewedAt: number | null;
  currentPathState: TurnChangeCurrentPathState;
  changes: TurnChangePath[];
}

export interface TurnChangeFilePreview {
  turnId: string;
  farfoldSessionId: string;
  relativePath: string;
  previousPath: string | null;
  changeKind: TurnChangeKind;
  fileState: TurnChangeFileState;
  source: "current_disk";
  baselineHeadOid: string | null;
  terminalHeadOid: string | null;
  currentPathState: TurnChangeCurrentPathState;
  byteCount: number | null;
  maxBytes: number;
  truncated: boolean;
  text: string | null;
  detail: string;
}

export interface TurnChangePathDiffPreview {
  turnId: string;
  farfoldSessionId: string;
  relativePath: string;
  previousPath: string | null;
  changeKind: TurnChangeKind;
  fileState: TurnChangeFileState;
  source: "current_disk_against_baseline";
  baselineHeadOid: string | null;
  terminalHeadOid: string | null;
  currentPathState: TurnChangeCurrentPathState;
  maxBytes: number;
  truncated: boolean;
  text: string | null;
  detail: string;
}

export function turnChangeReviewSnapshot(
  farfoldSessionId: string,
): Promise<TurnChangeReview[]> {
  return invoke("turn_change_review_snapshot", {
    input: { farfoldSessionId },
  });
}

export function markTurnChangesReviewed(
  farfoldSessionId: string,
  turnId: string,
): Promise<boolean> {
  return invoke("turn_change_review_mark", {
    input: { farfoldSessionId, turnId },
  });
}

export function turnChangeFilePreview(
  farfoldSessionId: string,
  turnId: string,
  relativePath: string,
): Promise<TurnChangeFilePreview> {
  return invoke("turn_change_file_preview", {
    input: { farfoldSessionId, turnId, relativePath },
  });
}

export function turnChangePathDiffPreview(
  farfoldSessionId: string,
  turnId: string,
  relativePath: string,
): Promise<TurnChangePathDiffPreview> {
  return invoke("turn_change_path_diff_preview", {
    input: { farfoldSessionId, turnId, relativePath },
  });
}
