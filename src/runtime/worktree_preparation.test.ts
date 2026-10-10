import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import {
  inspectWorktreePreparation,
  validateWorktreePreparation,
} from "./worktree_preparation";
import {
  parsePreparationInspection,
  parsePreparationValidation,
  validPreparationSubdirectory,
} from "./worktree_preparation_types";
import {
  preparationRequestText,
  validPreparationRequest,
} from "./worktree_preparation_request";
import {
  preparationFailureMessage,
  WORKTREE_PREPARATION_STRINGS as S,
} from "./worktree_preparation_strings";
import {
  preparationLocation as location,
  preparationWire,
} from "./worktree_preparation.test-fixtures";
beforeEach(() => h.invoke.mockReset());
it("uses the just-checked revision, validates only its ticket and sends no execution command", async () => {
  h.invoke.mockResolvedValueOnce(preparationWire());
  const checked = await inspectWorktreePreparation(location, "");
  h.invoke.mockResolvedValueOnce({
    inspectionId: checked.inspectionId,
    valid: true,
  });
  await validateWorktreePreparation(checked);
  expect(h.invoke.mock.calls).toEqual([
    [
      "worktree_preparation_inspect",
      { locationId: location.id, expectedRevision: 0, projectRelativePath: "" },
    ],
    ["worktree_preparation_validate", { inspectionId: checked.inspectionId }],
  ]);
  expect(Object.isFrozen(checked.facts[0])).toBe(true);
});
it.each([
  "location",
  "path",
  "revision",
  "role",
  "duplicate",
  "hole",
  "missing",
  "unknown",
  "coverage",
  "count",
  "ticket",
])("rejects malformed or mismatched %s without a usable ticket", (kind) => {
  const value = preparationWire();
  if (kind === "location") value.location.id = "other";
  if (kind === "path") value.projectPath = "/repo/elsewhere";
  if (kind === "revision") value.location.revision = 1;
  if (kind === "role") value.facts[0].role = "lock";
  if (kind === "duplicate") value.facts[1] = { ...value.facts[0] };
  if (kind === "hole") delete value.facts[0];
  if (kind === "missing") value.facts.pop();
  if (kind === "unknown") Object.assign(value, { configContents: "secret" });
  if (kind === "coverage") value.facts[0].nodeKind = "unreadable";
  if (kind === "count") value.git.otherWorktreeCount = 256;
  if (kind === "ticket") value.inspectionId = "not-an-id";
  expect(() => parsePreparationInspection(value, location, "")).toThrow();
});
it.each([
  "../x",
  "/tmp",
  "a//b",
  "a/",
  ".git",
  "x/.GIT/a",
  "a\\b",
  "a\u0085b",
  "a/b/c/d/e/f/g/h/i",
])("rejects unsafe relative path %s", (path) =>
  expect(validPreparationSubdirectory(path)).toBe(false),
);
it("counts UTF8 bytes and preserves explicit Unicode directory spelling", () => {
  expect(validPreparationSubdirectory("项目/应用")).toBe(true);
  expect(validPreparationSubdirectory("字".repeat(342))).toBe(false);
});
it("unreadable is explicit, and a directory name never proves installed dependencies", () => {
  const value = preparationWire();
  value.facts[0].nodeKind = "unreadable";
  value.coverage.complete = false;
  const inspection = parsePreparationInspection(value, location, "");
  const text = preparationRequestText(
    location.path,
    { task: "运行测试", projectRelativePath: "", service: false, port: "" },
    inspection,
  );
  expect(text).toContain("package.json：无法检查");
  expect(text).toContain(S.incomplete);
  expect(text).toContain("不代表依赖完整或环境已就绪");
});
it("manual requests disclose unchecked facts, and desired ports are not reserved", () => {
  const request = {
    task: "看预览",
    projectRelativePath: "web",
    service: true,
    port: "3000",
  };
  expect(validPreparationRequest(request)).toBe(true);
  expect(validPreparationRequest({ ...request, port: "65536" })).toBe(false);
  const text = preparationRequestText(location.path, request, null);
  expect(text).toContain("/repo/tree/web");
  expect(text).toContain(S.manualBoundary);
  expect(text).toContain("端口尚未检查或预留");
  expect(text).not.toContain("package.json：");
});
it("wrong or decorated validation replies cannot authorize insertion", () => {
  for (const reply of [
    null,
    { inspectionId: "other", valid: true },
    { inspectionId: "id", valid: false },
    { inspectionId: "id", valid: true, extra: true },
  ])
    expect(() => parsePreparationValidation(reply, "id")).toThrow();
});
it("fixed failures are useful without rendering raw backend text", () => {
  expect(
    preparationFailureMessage({ code: "inspectionExpired", message: "secret" }),
  ).toBe(S.errors.inspectionExpired);
  expect(preparationFailureMessage({ code: "future", message: "secret" })).toBe(
    S.unavailable,
  );
  expect(preparationFailureMessage("secret")).toBe(S.unavailable);
});
