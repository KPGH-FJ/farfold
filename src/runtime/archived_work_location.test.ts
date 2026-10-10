import { describe, expect, it, vi } from "vitest";
vi.mock("./worktrees", () => ({
  worktrees: {
    snapshot: () => {
      throw Error("not needed");
    },
  },
}));
import {
  findArchivedWorkLocation,
  findWorkLocationGuidance,
} from "./archived_work_location";
import type { WorktreeArchive } from "./worktree_types";
import { ARCHIVED_WORK_LOCATION } from "./archived_work_location_strings";
const archive: WorktreeArchive = Object.freeze({
  id: "archive",
  revision: 1,
  originalPath: "/controlled/project",
  retainedPath: "/controlled/saved",
  repositoryRoot: "/controlled/repo",
  branch: null,
  headOid: "a".repeat(40),
  ownership: "created",
  availability: "unknown",
});
const state = { ready: true, loading: false, error: null, archives: [archive] };
describe("archived location association", () => {
  it.each([
    "/controlled/project",
    "/controlled/project/a",
    "/controlled/project/中文/a",
  ])("matches complete components only: %s", (cwd) => {
    expect(findArchivedWorkLocation(state, cwd)).toBe(archive);
  });
  it.each([
    null,
    "",
    "/controlled/project-other",
    "/controlled/projects/a",
    "/controlled",
    "/controlled/saved",
    "/ordinary/missing",
    "controlled/project",
    "/controlled/project/..",
    "/controlled/project/./a",
    "/controlled//project",
    "/controlled/project/",
    "/controlled/project\0/a",
    "/controlled/project\\a",
    "/Controlled/project",
  ])("does not guess normalized or unrelated ownership: %s", (cwd) => {
    expect(findArchivedWorkLocation(state, cwd)).toBeNull();
  });
  it.each([{ ready: false }, { loading: true }, { error: "read failed" }])(
    "rejects stale or unavailable catalogues %o",
    (change) => {
      expect(
        findArchivedWorkLocation({ ...state, ...change }, archive.originalPath),
      ).toBeNull();
    },
  );
  it.each(["unknown", "missing", "changed", "verified"] as const)(
    "records %s availability without claiming current filesystem presence",
    (availability) => {
      const record = { ...archive, availability };
      expect(
        findArchivedWorkLocation(
          { ...state, archives: [record] },
          archive.originalPath,
        ),
      ).toBe(record);
    },
  );
  it("rejects overlapping archive records rather than choosing an arbitrary destination", () => {
    expect(
      findArchivedWorkLocation(
        {
          ...state,
          archives: [
            archive,
            { ...archive, id: "other", originalPath: "/controlled/project/a" },
          ],
        },
        "/controlled/project/a",
      ),
    ).toBeNull();
  });
  it("withdraws after restore removes the record", () => {
    expect(
      findArchivedWorkLocation(
        { ...state, archives: [] },
        archive.originalPath,
      ),
    ).toBeNull();
  });
  it("keeps the shared copy free of internal terminology", () => {
    for (const value of Object.values(ARCHIVED_WORK_LOCATION))
      expect(value).not.toMatch(
        /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i,
      );
  });
});

const recoveries = [
  { id: "one", originalPath: archive.originalPath },
  { id: "two", originalPath: archive.originalPath },
] as import("./worktree_types").WorktreeRecovery[];
describe("recovery-copy association", () => {
  it("preserves the whole collection without choosing one backup", () => {
    const v = findWorkLocationGuidance(
      { ...state, archives: [], recoveries },
      archive.originalPath + "/nested",
    );
    expect(v).toEqual({ kind: "recovery", source: recoveries });
    expect(v?.source).toBe(recoveries);
  });
  it("prefers an archive over recovery copies and rejects conflicting archives", () => {
    expect(
      findWorkLocationGuidance({ ...state, recoveries }, archive.originalPath),
    ).toEqual({ kind: "archive", source: archive });
    expect(
      findWorkLocationGuidance(
        {
          ...state,
          archives: [archive, { ...archive, id: "another" }],
          recoveries,
        },
        archive.originalPath,
      ),
    ).toBeNull();
  });
  it.each([
    "/controlled/project-other",
    "/controlled/project/../x",
    "/controlled/project/",
    "/controlled/saved",
  ])("does not infer backup association at %s", (cwd) => {
    expect(
      findWorkLocationGuidance({ ...state, archives: [], recoveries }, cwd),
    ).toBeNull();
  });
  it.each([{ ready: false }, { loading: true }, { error: "failed" }])(
    "does not treat unavailable catalogue as recovery evidence %o",
    (change) => {
      expect(
        findWorkLocationGuidance(
          { ...state, ...change, archives: [], recoveries },
          archive.originalPath,
        ),
      ).toBeNull();
    },
  );
  it("withdraws when no recovery is still associated", () => {
    expect(
      findWorkLocationGuidance(
        { ...state, archives: [], recoveries: [] },
        archive.originalPath,
      ),
    ).toBeNull();
  });
});
