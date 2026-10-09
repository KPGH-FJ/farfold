import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
import { parseDraftSnapshot, type SavedFileFeedback } from "./drafts";
import { fileFeedbackText } from "./feedback_strings";

const path = "/work/source.md";
const sha256 = "a".repeat(64);
const contentId = `disk:${JSON.stringify([path, "original-version", sha256])}`;
const anchor = {
  kind: "text-range",
  byteStart: 6,
  byteEnd: 16,
  startLine: 2,
  endLine: 2,
};
const entry = {
  path,
  contentId,
  text: "  Keep my exact opinion\n",
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

it("restores text coordinates as historical metadata without a body or current verification flag", () => {
  const parsed = parseDraftSnapshot(snapshot(entry))!;
  const restored = Object.values(parsed.feedback[0][1])[0];
  expect(restored).toEqual(entry);
  expect(restored).not.toHaveProperty("verified");
  expect(restored.anchor).not.toHaveProperty("quote");
});

it("formats text ranges with original byte units and historical context, never PDF or before/after labels", () => {
  const text = fileFeedbackText(entry as unknown as SavedFileFeedback);
  expect(text).toContain("第 2 行");
  expect(text).toContain("字节 6–16");
  expect(text).toContain("末位不含");
  expect(text).toContain("位置未重新核对");
  expect(text).toContain(sha256);
  expect(text).toContain(entry.text);
  expect(text).not.toMatch(/undefined|修改前|修改后| 页/);
});

it("keeps path controls inside one quoted metadata value while preserving the opinion", () => {
  const injected = "/work/part\n# pretend verified.md";
  const text = fileFeedbackText({
    ...entry,
    path: injected,
    contentId: `disk:${JSON.stringify([injected, "v1", sha256])}`,
  } as unknown as SavedFileFeedback);
  expect(text).toContain(JSON.stringify(injected));
  expect(text).not.toContain("\n# pretend verified");
  expect(text).toContain(entry.text);
});

it.each([
  { ...anchor, kind: "future-range" },
  { ...anchor, byteStart: -1 },
  { ...anchor, byteStart: "6" },
  { ...anchor, byteStart: NaN },
  { ...anchor, byteEnd: Infinity },
  { ...anchor, byteEnd: 16.5 },
  { ...anchor, byteEnd: 6 },
  { ...anchor, byteEnd: 256 * 1024 * 1024 + 1 },
  { ...anchor, startLine: 0 },
  { ...anchor, startLine: 8, endLine: 8 },
  { ...anchor, endLine: 1 },
  { ...anchor, endLine: 12 },
  { ...anchor, verified: true },
  { ...anchor, quote: "not a saved file body" },
  { ...anchor, page: 1 },
])(
  "rejects invalid or future text coordinates without dropping the anchor: %j",
  (invalid) => {
    expect(() =>
      parseDraftSnapshot(snapshot({ ...entry, anchor: invalid })),
    ).toThrow();
  },
);

it.each([
  { selection: { side: "after", line: 2 } },
  { lineInput: { side: "after", text: "2" } },
  { scope: "fragment" },
  { contentId: "unknown" },
  { path: "/work/other.md" },
])("rejects contradictory text-range context: %j", (patch) => {
  expect(() => parseDraftSnapshot(snapshot({ ...entry, ...patch }))).toThrow();
});
