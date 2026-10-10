import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { parseDraftSnapshot, type SavedFileFeedback } from "./drafts";
import { fileFeedbackText } from "./feedback_strings";
import { parseFeedbackAnchor } from "./file_feedback_anchor";

const path = '/work/画面\n".pdf';
const contentId = `disk:${JSON.stringify([path, "old-v1", "a".repeat(64)])}`;
const image = {
  kind: "image-area",
  space: "display-oriented-v1",
  left: 0,
  top: 1,
  right: 999999,
  bottom: 1000000,
};
const pdf = { ...image, kind: "pdf-area", page: 2, pageCount: 3 };
const entry = (anchor: unknown) => ({
  path,
  contentId,
  text: "  保留意见\n",
  selection: null,
  scope: "file",
  anchor,
});
const context = {
  path,
  contentId,
  scope: "file",
  selection: null,
  lineInput: undefined,
};
const snapshot = (value: unknown) => ({
  version: 1,
  composers: {},
  queues: {},
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: { thread: { old: value } },
});

it.each([image, pdf])(
  "restores exact historical displayed area without live proof: %j",
  (anchor) => {
    const decoded = parseFeedbackAnchor(anchor, context);
    expect(decoded).toEqual(anchor);
    expect(decoded).not.toBe(anchor);
    const saved = Object.values(
      parseDraftSnapshot(snapshot(entry(anchor)))!.feedback[0][1],
    )[0];
    expect(saved).toEqual(entry(anchor));
    expect(saved.anchor).not.toHaveProperty("frame");
    expect(saved.anchor).not.toHaveProperty("preview");
  },
);

it.each([image, pdf])(
  "formats fixed-point displayed coordinates, version and exact opinion: %j",
  (anchor) => {
    const value = entry(anchor);
    const text = fileFeedbackText(value as SavedFileFeedback);
    expect(text).toContain(JSON.stringify(path));
    expect(text).toContain("显示画面左上角");
    expect(text).toContain("左 0%");
    expect(text).toContain("上 0.0001%");
    expect(text).toContain("右 99.9999%");
    expect(text).toContain("下 100%");
    expect(text).toContain("位置未重新核对");
    expect(text).toContain("a".repeat(64));
    expect(text).toContain(value.text);
    expect(text).not.toMatch(/undefined|原始像素|PDF 内部/);
    if (anchor.kind === "pdf-area") expect(text).toContain("第 2 / 3 页");
  },
);

it.each([
  { ...image, space: "pdf-user-space" },
  { ...image, space: undefined },
  { ...image, left: -1 },
  { ...image, right: 1000001 },
  { ...image, left: 1.5 },
  { ...image, left: "0" },
  { ...image, left: NaN },
  { ...image, top: Infinity },
  { ...image, left: 999999 },
  { ...image, top: 1000000 },
  { ...image, left: 1000000 },
  { ...image, bottom: 0 },
  { ...image, page: 1 },
  { ...pdf, page: 0 },
  { ...pdf, page: 4 },
  { ...pdf, pageCount: 1001 },
  { ...pdf, page: "2" },
  { ...pdf, frame: {} },
  { ...image, verified: true },
  { ...image, text: "must not persist pixels or text" },
  { ...image, kind: "pdf-page", page: 1, pageCount: 2 },
  { kind: "pdf-page", page: 1, pageCount: 2, left: 0 },
  {
    kind: "text-range",
    byteStart: 0,
    byteEnd: 1,
    startLine: 1,
    endLine: 1,
    space: "display-oriented-v1",
  },
  null,
  [],
])(
  "rejects malformed/mixed area without discarding its invalid fields: %j",
  (anchor) => {
    expect(() => parseDraftSnapshot(snapshot(entry(anchor)))).toThrow();
  },
);

it.each([
  { scope: "fragment" },
  { selection: { side: "after", line: 1 } },
  { lineInput: { side: "after", text: "1" } },
  { path: "/different.pdf" },
  { contentId: "unknown" },
])(
  "requires original disk identity and exact feedback context: %j",
  (patch) => {
    expect(() =>
      parseDraftSnapshot(snapshot({ ...entry(pdf), ...patch })),
    ).toThrow();
  },
);
