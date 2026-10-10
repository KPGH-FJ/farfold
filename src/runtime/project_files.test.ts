import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PROJECT_FILES,
  projectFilesError,
  projectFilesResult,
} from "./project_files";
import { projectFilesFixture } from "./project_files.test-support";

it.each(["complete", "truncated"])(
  "accepts the actual Rust %s response without fixture translation",
  (name) => {
    const wire = JSON.parse(
      readFileSync(
        "docs/evidence/2026-10-09-capability-hardening/project-file-selection/backend/actual-wire.json",
        "utf8",
      ),
    );
    const result = projectFilesResult(
      wire[name],
      wire[name].requestId,
      "/project",
    );
    expect(result.truncated).toBe(name === "truncated");
    expect(result.files).toHaveLength(name === "truncated" ? 2000 : 3);
    expect(result.limits.entriesPerDirectory).toBe(4096);
  },
);

it.each([
  "/outside",
  "../outside",
  "src/../../outside",
  "file:/outside",
  "a\u0000b",
])(
  "rejects an unsafe returned project path %j before it becomes selectable",
  (path) => {
    expect(() =>
      projectFilesResult(projectFilesFixture("one", [path]), "one", "/project"),
    ).toThrow();
  },
);

it("bounds response count and total path bytes, without silently discarding entries", () => {
  expect(() =>
    projectFilesResult(
      projectFilesFixture("one", Array(2001).fill("file.txt")),
      "one",
      "/project",
    ),
  ).toThrow();
  expect(() =>
    projectFilesResult(
      projectFilesFixture("one", ["x".repeat(1048577)]),
      "one",
      "/project",
    ),
  ).toThrow();
});

it("rejects mismatched requests and missing coverage instead of implying a complete listing", () => {
  expect(() =>
    projectFilesResult(projectFilesFixture("old"), "new", "/project"),
  ).toThrow();
  expect(() =>
    projectFilesResult({ requestId: "one", files: [] }, "one", "/project"),
  ).toThrow();
});

it("preserves reported incomplete and cancelled results with usable candidate paths", () => {
  const value = projectFilesFixture("one", ["folder/report %.md"], {
    truncated: true,
    partial: true,
    cancelled: true,
    limitReasons: ["entryLimit"],
  });
  expect(projectFilesResult(value, "one", "/project")).toBe(value);
});

it("renders only fixed errors, retaining observation timeout as unknown", () => {
  expect(projectFilesError({ code: "readPending", detail: "private" })).toBe(
    PROJECT_FILES.pending,
  );
  expect(projectFilesError({ code: "readBusy" })).toBe(PROJECT_FILES.busy);
  expect(projectFilesError("private path / token")).toBe(PROJECT_FILES.failed);
  expect(projectFilesError({ code: "private path / token" })).toBe(
    PROJECT_FILES.failed,
  );
});
