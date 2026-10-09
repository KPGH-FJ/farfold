import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import type { TextPreview, VerifiedFile } from "./file_delivery";
import type { TextBlockPreview } from "./text_block_preview";
import {
  createTextFeedbackSource,
  textFeedbackLineOffsets,
  textFeedbackRange,
  textFeedbackRangeMatches,
} from "./text_feedback_range";

const text = "\uFEFFA\r\n中🙂e\u0301\rZ\n";
const fileFor = (text: string): VerifiedFile => ({
  root: "/work",
  path: "/work/a.txt",
  resolvedPath: "/work/a.txt",
  name: "a.txt",
  size: new TextEncoder().encode(text).length,
  sha256: "a".repeat(64),
  version: "checked-version",
});
const sourceFor = (text: string) => {
  const file = fileFor(text);
  return createTextFeedbackSource({ file, text }, file)!;
};

describe("exact source coordinates (literal independent Python UTF-8 oracle)", () => {
  it.each([
    [4, 9, 6, 16, 2, 2, "中🙂é"],
    [1, 5, 3, 9, 1, 2, "A\r\n中"],
    [10, 12, 17, 19, 3, 3, "Z\n"],
    [2, 4, 4, 6, 1, 1, "\r\n"],
    [0, 1, 0, 3, 1, 1, "\uFEFF"],
  ] as const)(
    "keeps UTF-16 %d..%d as original UTF-8 %d..%d",
    (start, end, byteStart, byteEnd, startLine, endLine, selected) => {
      const source = sourceFor(text);
      const expected = {
        kind: "text-range",
        byteStart,
        byteEnd,
        startLine,
        endLine,
      };
      expect(textFeedbackRange(source, start, end)).toEqual(expected);
      expect(textFeedbackRange(source, end, start)).toEqual(expected);
      expect(textFeedbackRangeMatches(source, expected as never)).toBe(true);
      expect(text.slice(start, end)).toBe(selected);
      expect(
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          new TextEncoder().encode(text).slice(byteStart, byteEnd),
        ),
      ).toBe(selected);
    },
  );
  it.each([
    [-1, 4],
    [0, NaN],
    [0, Infinity],
    [0, 13],
    [0, 0],
    [4, 6],
    [3, 4],
    [0, 1.5],
    ["1", 4],
  ])("rejects invalid or split endpoints %s..%s", (start, end) => {
    expect(textFeedbackRange(sourceFor(text), start as number, end)).toBeNull();
  });
  it("does not normalize combining marks or require a whole grapheme", () => {
    expect(textFeedbackRange(sourceFor(text), 8, 9)).toEqual({
      kind: "text-range",
      byteStart: 14,
      byteEnd: 16,
      startLine: 2,
      endLine: 2,
    });
  });
  it("maps CRLF, isolated CR and LF lines without adding an empty EOF line", () => {
    const source = sourceFor(text);
    expect(source).toMatchObject({
      byteStart: 0,
      byteEnd: 19,
      startLine: 1,
      endLine: 3,
    });
    expect(textFeedbackLineOffsets(source, 1, 1)).toEqual({ start: 0, end: 4 });
    expect(textFeedbackLineOffsets(source, 2, 2)).toEqual({
      start: 4,
      end: 10,
    });
    expect(textFeedbackLineOffsets(source, 2, 3)).toEqual({
      start: 4,
      end: 12,
    });
    expect(textFeedbackLineOffsets(source, 4, 4)).toBeNull();
    expect(textFeedbackLineOffsets(source, 3, 2)).toBeNull();
    expect(textFeedbackLineOffsets(source, 0, 1)).toBeNull();
  });
  it.each([
    "",
    "no final newline",
    "\n",
    "\r",
    "\r\n",
    "a\n\n",
    "\n".repeat(2000),
  ])("handles bounded empty/final/newline sources (%j)", (value) => {
    const source = sourceFor(value);
    const offsets = textFeedbackLineOffsets(
      source,
      source.startLine,
      source.endLine,
    );
    expect(offsets).toEqual(value ? { start: 0, end: value.length } : null);
    if (offsets)
      expect(
        textFeedbackRange(source, offsets.start, offsets.end)?.endLine,
      ).toBe(source.endLine);
    else expect(textFeedbackRange(source, 0, 0)).toBeNull();
  });
  it("retains mid-line block byte origin without inventing a global column or unloaded line prefix", () => {
    const whole = "x".repeat(131072) + "中🙂END\r\n尾\n",
      file = fileFor(whole);
    const block: TextBlockPreview = {
      file,
      text: "中🙂END\r\n尾\n",
      blockIndex: 1,
      blockCount: 2,
      byteStart: 131072,
      byteEnd: 131088,
      startLine: 1,
      endLine: 2,
      startsMidLine: true,
      endsMidLine: false,
    };
    const source = createTextFeedbackSource(block, file)!;
    expect(source.startsMidLine).toBe(true);
    expect(textFeedbackRange(source, 1, 6)).toEqual({
      kind: "text-range",
      byteStart: 131075,
      byteEnd: 131082,
      startLine: 1,
      endLine: 1,
    });
    expect(textFeedbackLineOffsets(source, 1, 1)).toEqual({ start: 0, end: 8 });
    expect(textFeedbackRange(source, 0, 8)).not.toHaveProperty("column");
  });
});

describe("successful read receipt boundary", () => {
  it("freezes a detached file identity, keeps no hidden content/history state", () => {
    const file = fileFor(text),
      receipt = { file, text };
    const source = createTextFeedbackSource(receipt, file)!;
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.file)).toBe(true);
    file.version = "new";
    receipt.text = "changed";
    expect(source.file.version).toBe("checked-version");
    expect(source.text).toBe(text);
    expect(textFeedbackRange({ ...source }, 0, 1)).toBeNull();
  });
  it.each([
    "root",
    "path",
    "resolvedPath",
    "name",
    "sha256",
    "version",
    "size",
  ] as const)("rejects a mismatched %s receipt", (key) => {
    const file = fileFor(text),
      other = { ...file, [key]: key === "size" ? 20 : "different" };
    expect(createTextFeedbackSource({ file: other, text }, file)).toBeNull();
  });
  it.each(["\ud800", "\udc00", "A\ud800B", "A\udc00B"])(
    "rejects non-scalar UTF-16 instead of encoder replacement %j",
    (value) => {
      expect(
        createTextFeedbackSource(
          { file: fileFor(value), text: value },
          fileFor(value),
        ),
      ).toBeNull();
    },
  );
  it("rejects truncated/normalized/full-text oversize and unknown receipt shapes", () => {
    const file = fileFor(text);
    expect(
      createTextFeedbackSource({ file, text: text.replace(/\r/g, "") }, file),
    ).toBeNull();
    expect(
      createTextFeedbackSource({ file, text: text.slice(1) }, file),
    ).toBeNull();
    expect(
      createTextFeedbackSource(
        { file, text, body: "extra" } as TextPreview,
        file,
      ),
    ).toBeNull();
    const large = "x".repeat(1024 * 1024 + 1);
    expect(
      createTextFeedbackSource(
        { file: fileFor(large), text: large },
        fileFor(large),
      ),
    ).toBeNull();
  });
  it("matches only real byte/scalar/newline boundaries and exact derived lines", () => {
    const source = sourceFor(text),
      anchor = textFeedbackRange(source, 4, 9)!;
    expect(textFeedbackRangeMatches(source, { ...anchor, byteStart: 7 })).toBe(
      false,
    );
    expect(textFeedbackRangeMatches(source, { ...anchor, byteStart: 5 })).toBe(
      false,
    );
    expect(textFeedbackRangeMatches(source, { ...anchor, startLine: 1 })).toBe(
      false,
    );
    expect(textFeedbackRangeMatches(source, { ...anchor, byteEnd: 20 })).toBe(
      false,
    );
    expect(textFeedbackRangeMatches(structuredClone(source), anchor)).toBe(
      false,
    );
  });
  it("accepts the existing actual Rust wire receipts and never treats the historical fixture as a live file read", () => {
    const blocks = JSON.parse(
      readFileSync(
        new URL(
          "../../docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as TextBlockPreview[];
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      const source = createTextFeedbackSource(block, block.file)!;
      expect(source).not.toBeNull();
      const anchor = textFeedbackRange(source, 0, source.text.length)!;
      expect(anchor.byteStart).toBe(block.byteStart);
      expect(anchor.byteEnd).toBe(block.byteEnd);
      expect(anchor.startLine).toBe(block.startLine);
      expect(anchor.endLine).toBe(block.endLine);
      expect(textFeedbackRangeMatches(source, anchor)).toBe(true);
      expect(
        createTextFeedbackSource(
          { ...block, endLine: block.endLine + 1 },
          block.file,
        ),
      ).toBeNull();
    }
  });
});
