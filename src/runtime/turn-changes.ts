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

export interface TurnChangePath {
  relativePath: string;
  previousPath: string | null;
  changeKind: TurnChangeKind;
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
  changes: TurnChangePath[];
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
