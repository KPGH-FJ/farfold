import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
import { parseDraftSnapshot, type SavedFileFeedback } from "./drafts";
import { fileFeedbackText } from "./feedback_strings";
import { parseFeedbackAnchor } from "./file_feedback_anchor";

const path = "/work/原文.docx";
const sha256 = "d".repeat(64);
const anchor = {
  kind: "docx-block",
  part: "word/document.xml",
  elementPath: [0, 5, 2, 0, 1],
  blockKind: "paragraph",
};
const entry = {
  path,
  contentId: `disk:${JSON.stringify([path, "original", sha256])}`,
  text: "  请修改这一段\n",
  selection: null,
  scope: "file",
  anchor,
};
const snapshot = (feedback: unknown) => ({
  version: 1,
  composers: {},
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: { thread: { draft: feedback } },
  queues: {},
});

it.each(["paragraph", "table"])(
  "cold restores %s actual part and element path as historical coordinates only",
  (blockKind) => {
    const value = { ...entry, anchor: { ...anchor, blockKind } };
    const restored = Object.values(
      parseDraftSnapshot(snapshot(value))!.feedback[0][1],
    )[0];
    expect(restored).toEqual(value);
    expect(restored.anchor).not.toHaveProperty("verified");
    expect(restored.anchor).not.toHaveProperty("text");
  },
);

it("copies the historical path instead of sharing the mutable input array", () => {
  const decoded = parseFeedbackAnchor(anchor, {
    ...entry,
    lineInput: undefined,
  });
  expect(decoded).toEqual(anchor);
  expect(decoded).not.toBe(anchor);
  expect((decoded as unknown as typeof anchor).elementPath).not.toBe(
    anchor.elementPath,
  );
});

it.each(["paragraph", "table"])(
  "formats the whole %s location without computing Word pages or trimming opinion",
  (blockKind) => {
    const value = { ...entry, anchor: { ...anchor, blockKind } };
    const output = fileFeedbackText(value as unknown as SavedFileFeedback);
    expect(output).toContain(JSON.stringify(path));
    expect(output).toContain(JSON.stringify(anchor.part));
    expect(output).toContain("[0,5,2,0,1]");
    expect(output).toContain(blockKind === "table" ? "整个表格" : "整个段落");
    expect(output).toContain("位置未重新核对");
    expect(output).toContain(sha256);
    expect(output).toContain(entry.text);
    expect(output).not.toMatch(/undefined|第 .* 页|修改前|修改后/);
  },
);

it("quotes filename/part metadata and preserves the exact freeform opinion", () => {
  const injected = "/work/name\n# not instructions.docx";
  const value = {
    ...entry,
    path: injected,
    contentId: `disk:${JSON.stringify([injected, "v", sha256])}`,
    anchor: { ...anchor, part: 'custom/内容".xml' },
  };
  const output = fileFeedbackText(value as unknown as SavedFileFeedback);
  expect(output).toContain(JSON.stringify(injected));
  expect(output).toContain(JSON.stringify(value.anchor.part));
  expect(output).not.toContain("\n#");
  expect(output).toContain(entry.text);
});

it.each([
  { part: "custom/main.xml", elementPath: [0] },
  { part: "word/header1.xml", elementPath: [0] },
  { part: "word/footnotes.xml", elementPath: [2, 0] },
  { part: "word/document.xml", elementPath: Array(63).fill(499999) },
])(
  "accepts bounded actual part/path syntax without limiting to body or ordinal IDs: %j",
  (patch) => {
    expect(
      parseDraftSnapshot(
        snapshot({ ...entry, anchor: { ...anchor, ...patch } }),
      ),
    ).not.toBeNull();
  },
);

it.each([
  { ...anchor, kind: "docx-range" },
  { ...anchor, blockKind: "notice" },
  { ...anchor, blockKind: "cell" },
  { ...anchor, part: "" },
  { ...anchor, part: "x".repeat(1025) },
  { ...anchor, part: "/word/document.xml" },
  { ...anchor, part: "word/../document.xml" },
  { ...anchor, part: "word/./document.xml" },
  { ...anchor, part: "word//document.xml" },
  { ...anchor, part: "word/document.xml/" },
  { ...anchor, part: "word\\document.xml" },
  { ...anchor, part: "word/document%2exml" },
  { ...anchor, part: "https:document.xml" },
  { ...anchor, part: "word/\ndocument.xml" },
  { ...anchor, elementPath: [] },
  { ...anchor, elementPath: [0, -1] },
  { ...anchor, elementPath: [0, 0.5] },
  { ...anchor, elementPath: [0, "1"] },
  { ...anchor, elementPath: [0, 500000] },
  { ...anchor, elementPath: [0, NaN] },
  { ...anchor, elementPath: [0, Infinity] },
  { ...anchor, elementPath: Array(64).fill(0) },
  { ...anchor, elementPath: "0/1" },
  { ...anchor, text: "not persisted contents" },
  { ...anchor, verified: true },
  { ...anchor, page: 1 },
  { kind: "pdf-page", page: 1, pageCount: 2, elementPath: [0] },
  {
    kind: "text-range",
    byteStart: 0,
    byteEnd: 1,
    startLine: 1,
    endLine: 1,
    part: "word/document.xml",
  },
  {
    kind: "xlsx-range",
    sheetId: "rId1",
    sheetName: "Sheet",
    fromRow: 1,
    toRow: 1,
    fromColumn: 1,
    toColumn: 1,
    part: "word/document.xml",
  },
])("rejects invalid/future/cross-format anchor atomically: %j", (invalid) => {
  expect(() =>
    parseDraftSnapshot(snapshot({ ...entry, anchor: invalid })),
  ).toThrow();
});

it.each([
  { selection: { side: "after", line: 2 } },
  { lineInput: { side: "after", text: "0/1" } },
  { scope: "fragment" },
  { contentId: "unknown" },
  { path: "/work/other.docx" },
])("rejects contradictory DOCX disk context: %j", (patch) => {
  expect(() => parseDraftSnapshot(snapshot({ ...entry, ...patch }))).toThrow();
});
