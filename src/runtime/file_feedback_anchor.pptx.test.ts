import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
import { parseDraftSnapshot, type SavedFileFeedback } from "./drafts";
import { fileFeedbackText, FEEDBACK_STRINGS } from "./feedback_strings";
import type { PptxSlideAnchor } from "./file_feedback_anchor";
const path = "/work/讲稿.pptx",
  sha = "a".repeat(64);
const entry: SavedFileFeedback = {
  path,
  text: "  exact opinion\n",
  selection: null,
  scope: "file",
  contentId: `disk:${JSON.stringify([path, "v1", sha])}`,
  anchor: {
    kind: "pptx-slide",
    part: "ppt/slides/slide3.xml",
    previewSlide: 2,
    previewSlideCount: 2,
  },
};
const snapshot = (value: unknown) => ({
  version: 1,
  composers: {},
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: { thread: { item: value } },
  queues: {},
});
it("restores only historical slide metadata, never live ownership or original page-number promises", () => {
  const parsed = parseDraftSnapshot(snapshot(entry))!;
  expect(Object.values(parsed.feedback[0][1])[0]).toEqual(entry);
  const text = fileFeedbackText(entry);
  expect(text).toContain("当时预览第 2 / 2 页");
  expect(text).toContain("仅按预览显示的幻灯片计数");
  expect(text).toContain(sha);
  expect(text).toContain(entry.text);
  expect(text).toContain('文件内定位依据 "ppt/slides/slide3.xml"');
  expect(
    FEEDBACK_STRINGS.presentationSlide(entry.anchor as PptxSlideAnchor),
  ).not.toContain("slide3.xml");
  expect(text).not.toContain("原文件第 2 页");
});
it("distinguishes original slide parts even when preview ordinal and opinion text are identical", () => {
  const other = {
    ...entry,
    anchor: {
      kind: "pptx-slide" as const,
      part: "ppt/slides/slide4.xml",
      previewSlide: 2,
      previewSlideCount: 2,
    },
  };
  expect(fileFeedbackText(other)).toContain(
    '文件内定位依据 "ppt/slides/slide4.xml"',
  );
  expect(fileFeedbackText(other)).not.toBe(fileFeedbackText(entry));
});
it.each([
  { part: "../secret" },
  { part: "/absolute" },
  { part: "https://host/page" },
  { previewSlide: 0 },
  { previewSlide: 3 },
  { previewSlideCount: 1001 },
  { previewSlide: 1.5 },
  { verified: true },
])("rejects invalid historical slide anchor %j", (patch) => {
  expect(() =>
    parseDraftSnapshot(
      snapshot({ ...entry, anchor: { ...entry.anchor, ...patch } }),
    ),
  ).toThrow();
});
