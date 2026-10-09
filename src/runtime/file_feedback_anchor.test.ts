import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
import { parseDraftSnapshot, type SavedFileFeedback } from "./drafts";
import { fileFeedbackText } from "./feedback_strings";
const path = "/work/result.pdf",
  sha256 = "a".repeat(64);
const contentId = `disk:${JSON.stringify([path, "v1", sha256])}`;
const entry = {
  path,
  contentId,
  scope: "file",
  selection: null,
  text: "Change this heading",
  anchor: { kind: "pdf-page", page: 2, pageCount: 4 },
};
const snapshot = (feedback: unknown) => ({
  version: 1,
  composers: {},
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: { thread: { draft: feedback } },
  queues: {},
});
it("restores the exact PDF page anchor on its disk version without adding a content copy", () => {
  const parsed = parseDraftSnapshot(snapshot(entry))!;
  expect(Object.values(parsed.feedback[0][1])[0]).toMatchObject(entry);
});
it.each([
  { kind: "future", page: 2, pageCount: 4 },
  { kind: "pdf-page", page: 0, pageCount: 4 },
  { kind: "pdf-page", page: 5, pageCount: 4 },
  { kind: "pdf-page", page: 1.2, pageCount: 4 },
  { kind: "pdf-page", page: 2, pageCount: 1001 },
  { kind: "pdf-page", page: 2, pageCount: 4, rectangle: [0, 0, 1, 1] },
  null,
])(
  "rejects an unsupported or invalid anchor instead of silently restoring a file-wide opinion: %j",
  (anchor) => {
    expect(() => parseDraftSnapshot(snapshot({ ...entry, anchor }))).toThrow();
  },
);
it.each([
  { selection: { side: "after", line: 2 } },
  { lineInput: { side: "after", text: "2" } },
  { scope: "fragment" },
  { contentId: "unknown-version" },
  { path: "/other.pdf" },
  { futureLocation: { page: 9 } },
])("rejects contradictory or unknown location metadata: %j", (difference) => {
  expect(() =>
    parseDraftSnapshot(snapshot({ ...entry, ...difference })),
  ).toThrow();
});
it("formats the old page and exact saved digest, without promising that the current file still matches", () => {
  const text = fileFeedbackText(entry as SavedFileFeedback);
  expect(text).toContain("第 2 / 4 页");
  expect(text).toContain(sha256);
  expect(text).toContain("若文件已变化");
  expect(text).toContain("Change this heading");
});
it("retains legacy before/after line feedback without requiring a visual anchor", () => {
  const line = {
    ...entry,
    anchor: undefined,
    contentId: "legacy",
    scope: "fragment",
    selection: { side: "before", line: 2, endLine: 4 },
  };
  expect(parseDraftSnapshot(snapshot(line))).toBeDefined();
  expect(fileFeedbackText(line as SavedFileFeedback)).toContain(
    "修改前片段第 2–4 行",
  );
});
