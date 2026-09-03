import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  createManagedWorktree,
  previewManagedWorktree,
  type ManagedWorktreePreview,
} from "./working-copy";

const preview: ManagedWorktreePreview = {
  sourceWorkingCopyId: "copy-root",
  projectId: "project-1",
  sourcePath: "/project",
  sourceBranchName: "main",
  sourceHeadOid: "a".repeat(40),
  sourceGitStatus: {
    state: "dirty",
    stagedPathCount: 1,
    unstagedPathCount: 2,
    untrackedPathCount: 3,
    conflictedPathCount: 0,
  },
  branchName: "farfold/task",
  workingCopyId: "copy-worktree",
  workingCopyPath: "/app-data/worktrees/task",
  requiresLocalChangesChoice: true,
};

describe("managed Working Copy commands", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("keeps preview and explicit dirty-source confirmation separate", async () => {
    await previewManagedWorktree("copy-root", "farfold/task");
    await createManagedWorktree(preview, "use_head_only");

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "managed_worktree_creation_preview",
      {
        input: {
          sourceWorkingCopyId: "copy-root",
          branchName: "farfold/task",
        },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "managed_worktree_create", {
      input: { preview, localChangesChoice: "use_head_only" },
    });
  });
});
