import { invoke } from "@tauri-apps/api/core";
import type { WorktreeLocation } from "./worktree_types";
import {
  parsePreparationInspection,
  parsePreparationValidation,
  validPreparationSubdirectory,
  type PreparationInspection,
} from "./worktree_preparation_types";

/** Reads only; no operation journal, command execution or implicit retry. */
export async function inspectWorktreePreparation(
  location: WorktreeLocation,
  projectRelativePath: string,
): Promise<PreparationInspection> {
  if (
    location.availability !== "verified" ||
    !validPreparationSubdirectory(projectRelativePath)
  )
    throw { code: "unsafePath" };
  return parsePreparationInspection(
    await invoke("worktree_preparation_inspect", {
      locationId: location.id,
      expectedRevision: location.revision,
      projectRelativePath,
    }),
    location,
    projectRelativePath,
  );
}
export async function validateWorktreePreparation(
  inspection: PreparationInspection,
): Promise<void> {
  parsePreparationValidation(
    await invoke("worktree_preparation_validate", {
      inspectionId: inspection.inspectionId,
    }),
    inspection.inspectionId,
  );
}
