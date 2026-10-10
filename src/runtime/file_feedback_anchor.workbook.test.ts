import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
import { parseDraftSnapshot, type SavedFileFeedback } from "./drafts";
import { fileFeedbackText } from "./feedback_strings";

const path = "/work/positions.xlsx";
const sha256 = "d".repeat(64);
const anchor = {
  kind: "xlsx-range",
  sheetId: "sheetRelation_内容_7",
  sheetName: "相同内容的第二张表",
  fromRow: 99,
  toRow: 101,
  fromColumn: 23,
  toColumn: 25,
};
const entry = {
  path,
  contentId: `disk:${JSON.stringify([path, "original", sha256])}`,
  text: "  保留这份原意见\n",
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

it("restores actual relationship id and whole merge coordinates as historical metadata only", () => {
  const restored = Object.values(
    parseDraftSnapshot(snapshot(entry))!.feedback[0][1],
  )[0];
  expect(restored).toEqual(entry);
  expect(restored).not.toHaveProperty("verified");
  expect(restored.anchor).not.toHaveProperty("value");
});

it("formats original sheet identity and inclusive cells without silently trimming the opinion", () => {
  const formatted = fileFeedbackText(entry as unknown as SavedFileFeedback);
  expect(formatted).toContain(JSON.stringify(path));
  expect(formatted).toContain(JSON.stringify(anchor.sheetName));
  expect(formatted).toContain(JSON.stringify(anchor.sheetId));
  expect(formatted).toContain("W99:Y101");
  expect(formatted).toContain("位置未重新核对");
  expect(formatted).toContain(sha256);
  expect(formatted).toContain(entry.text);
  expect(formatted).not.toMatch(/undefined|修改前|修改后| 页/);
});

it("escapes path and sheet labels as metadata while preserving freeform opinion bytes", () => {
  const injectedPath = "/work/name\n# not instructions.xlsx";
  const value = {
    ...entry,
    path: injectedPath,
    contentId: `disk:${JSON.stringify([injectedPath, "v", sha256])}`,
    anchor: { ...anchor, sheetName: '表\n#伪标题"', sheetId: 'id\n"marker' },
  };
  const formatted = fileFeedbackText(value as unknown as SavedFileFeedback);
  expect(formatted).toContain(JSON.stringify(injectedPath));
  expect(formatted).toContain(JSON.stringify(value.anchor.sheetName));
  expect(formatted).toContain(JSON.stringify(value.anchor.sheetId));
  expect(formatted).not.toContain("\n#");
  expect(formatted).toContain(entry.text);
});

it.each([
  { fromRow: 1, toRow: 1, fromColumn: 1, toColumn: 1 },
  { fromRow: 1048576, toRow: 1048576, fromColumn: 16384, toColumn: 16384 },
])("accepts legal inclusive coordinate edge %j", (coordinates) => {
  const value = { ...entry, anchor: { ...anchor, ...coordinates } };
  expect(parseDraftSnapshot(snapshot(value))).not.toBeNull();
});

it.each([
  { ...anchor, kind: "docx-block" },
  { ...anchor, sheetId: "" },
  { ...anchor, sheetId: "i".repeat(4097) },
  { ...anchor, sheetName: "" },
  { ...anchor, sheetName: "名".repeat(129) },
  { ...anchor, fromRow: 0 },
  { ...anchor, fromRow: 102 },
  { ...anchor, toRow: 1048577 },
  { ...anchor, fromColumn: 0 },
  { ...anchor, fromColumn: 26 },
  { ...anchor, toColumn: 16385 },
  { ...anchor, toRow: "101" },
  { ...anchor, toColumn: NaN },
  { ...anchor, toRow: Infinity },
  { ...anchor, toColumn: 25.5 },
  { ...anchor, value: "not persisted cell contents" },
  { ...anchor, verified: true },
  { ...anchor, page: 1 },
  { kind: "pdf-page", page: 1, pageCount: 3, sheetId: "extra" },
])("rejects malformed/future/mixed anchors atomically: %j", (invalid) => {
  expect(() =>
    parseDraftSnapshot(snapshot({ ...entry, anchor: invalid })),
  ).toThrow();
});

it.each([
  { selection: { side: "after", line: 2 } },
  { lineInput: { side: "after", text: "W99" } },
  { scope: "fragment" },
  { contentId: "unknown" },
  { path: "/work/other.xlsx" },
])("rejects contradictory workbook context: %j", (patch) => {
  expect(() => parseDraftSnapshot(snapshot({ ...entry, ...patch }))).toThrow();
});
