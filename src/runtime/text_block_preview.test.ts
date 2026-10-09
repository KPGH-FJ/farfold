import { describe, expect, it } from "vitest";
import { parseTextBlock } from "./text_block_preview";
import type { VerifiedFile } from "./file_delivery";
const file: VerifiedFile = {
  root: "/w",
  path: "a.md",
  resolvedPath: "/w/a.md",
  name: "a.md",
  size: 12,
  sha256: "abc",
  version: "1",
};
const block = {
  file,
  blockIndex: 0,
  blockCount: 2,
  byteStart: 0,
  byteEnd: 7,
  startLine: 1,
  endLine: 2,
  startsMidLine: false,
  endsMidLine: true,
  text: "中\r\nab",
};
describe("verified text blocks", () => {
  it("accepts exact original byte coordinates including multibyte and CRLF", () =>
    expect(parseTextBlock(block, file, 0)).toEqual(block));
  it("accepts a smaller last block only for explicit revision position restoration", () => {
    const last = {
      ...block,
      blockIndex: 1,
      byteStart: 7,
      byteEnd: 12,
      startLine: 2,
      endLine: 3,
      startsMidLine: true,
      endsMidLine: false,
      text: "c\nend",
    };
    expect(parseTextBlock(last, file, 90, true)).toEqual(last);
    expect(() => parseTextBlock(last, file, 90)).toThrow();
  });
  it("preserves BOM and exact empty-file shape", () => {
    const empty = {
      ...block,
      file: { ...file, size: 0 },
      blockCount: 1,
      byteEnd: 0,
      endLine: 1,
      endsMidLine: false,
      text: "",
    };
    expect(parseTextBlock(empty, empty.file, 0)).toEqual(empty);
    const bom = {
      ...empty,
      file: { ...file, size: 4 },
      byteEnd: 4,
      text: "\ufeffx",
    };
    expect(parseTextBlock(bom, bom.file, 0).text).toBe("\ufeffx");
  });
  it.each([
    { file: { ...file, version: "2" } },
    { byteEnd: 8 },
    { endLine: 3 },
    { blockIndex: 1 },
    { byteStart: 1 },
    { startsMidLine: true },
    { extra: "future" },
    { text: "\ud800aaaa" },
    { blockCount: Infinity },
  ])("rejects mismatched or impossible receipts %j", (patch) =>
    expect(() => parseTextBlock({ ...block, ...patch }, file, 0)).toThrow(),
  );
  it("rejects excess text and more than 2000 logical line breaks", () => {
    for (const text of ["a".repeat(131073), "\r\n".repeat(2001)]) {
      const next = {
        ...block,
        text,
        byteEnd: new TextEncoder().encode(text).length,
      };
      expect(() =>
        parseTextBlock(next, { ...file, size: next.byteEnd + 1 }, 0),
      ).toThrow();
    }
  });
});
