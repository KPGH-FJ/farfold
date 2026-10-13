import { describe, expect, it } from "vitest";
import oracle from "./fixtures/line-diff/oracle.json";
import {
  compareLines,
  comparisonFor,
  DIFF_LIMITS,
  textLineCount,
  textLines,
} from "./line_diff";
import { comparisonCopy } from "./line_diff_presentation";

// Manually authored before implementation; no expected values come from the parser.
const cases = oracle.cases.filter((c) => "before" in c) as {
  id: string;
  before: string | null;
  after: string;
  expected: {
    bodyAdds?: number;
    bodyRemoves?: number;
    comparison?: string;
    sameText?: string[];
    addedText?: string[];
    removedText?: string[];
    endingChanges?: object[];
    endingChangeLines?: number[];
    noPhantomSecondPhysicalLine?: boolean;
  };
}[];
describe("manual oracle", () => {
  it.each(cases)("$id", ({ before, after, expected }) => {
    const result = compareLines(before, after);
    if (expected.comparison) expect(result.precision).toBe(expected.comparison);
    if (expected.bodyAdds !== undefined)
      expect(result.stats).toEqual({
        adds: expected.bodyAdds,
        removes: expected.bodyRemoves,
      });
    if (expected.sameText)
      expect(
        result.rows.filter((r) => r.kind === "same").map((r) => r.text),
      ).toEqual(expected.sameText);
    if (expected.addedText)
      expect(
        result.rows.filter((r) => r.kind === "add").map((r) => r.text),
      ).toEqual(expected.addedText);
    if (expected.removedText)
      expect(
        result.rows.filter((r) => r.kind === "remove").map((r) => r.text),
      ).toEqual(expected.removedText);
    if (expected.endingChanges)
      expect(result.endingChanges).toEqual(expected.endingChanges);
    if (expected.endingChangeLines)
      expect(result.endingChanges.map((c) => c.oldLine)).toEqual(
        expected.endingChangeLines,
      );
    if (expected.noPhantomSecondPhysicalLine) {
      expect(result.rows).toEqual([
        { kind: "same", oldLine: 1, newLine: 1, text: "a" },
      ]);
      expect(result.endingChanges).toEqual([
        { oldLine: 1, newLine: 1, before: "LF", after: "none" },
      ]);
    }
    if (before === null) {
      expect(result.stats).toBeNull();
      expect(
        result.rows.every((r) => r.oldLine === null && r.kind === "uncompared"),
      ).toBe(true);
    }
    // Rebuild each exact source using its own terminators and real coordinates.
    for (const [text, side] of [
      [before, "oldLine"],
      [after, "newLine"],
    ] as const) {
      if (text === null) continue;
      const original = textLines(text);
      expect(
        result.rows
          .filter((r) => r[side] !== null)
          .map((row) => {
            const ending = original[row[side]! - 1].ending;
            return (
              row.text +
              (ending === "LF" ? "\n" : ending === "CRLF" ? "\r\n" : "")
            );
          })
          .join(""),
      ).toBe(text);
      expect(textLineCount(text)).toBe(original.length);
    }
  });
});

it("does not treat a bare CR as a line terminator or normalize body Unicode", () => {
  expect(textLines("a\rb\r\n")).toEqual([{ text: "a\rb", ending: "CRLF" }]);
  expect(textLineCount("a\rb")).toBe(1);
  expect(compareLines("a\r", "a").stats).toEqual({ adds: 1, removes: 1 });
});

it("matches an independently written physical-row and ending oracle exactly", () => {
  const raw = "甲\r\n\n乙\n\r尾";
  const expected = [
    { text: "甲", ending: "CRLF" },
    { text: "", ending: "LF" },
    { text: "乙", ending: "LF" },
    { text: "\r尾", ending: "none" },
  ];
  expect(textLines(raw)).toEqual(expected);
  expect(textLineCount(raw)).toBe(4);
  expect(
    expected
      .map(
        (r) =>
          r.text +
          (r.ending === "CRLF" ? "\r\n" : r.ending === "LF" ? "\n" : ""),
      )
      .join(""),
  ).toBe(raw);
  expect(textLines("\r\n")).toEqual([{ text: "", ending: "CRLF" }]);
  expect(textLines("a\n")).toEqual([{ text: "a", ending: "LF" }]);
  expect(textLines("")).toEqual([]);
});

it("keeps source byte order in repeated rows and uneven replacements", () => {
  const result = compareLines("A\nX\nA\n", "A\nY\nA\n");
  expect(
    result.rows
      .filter((r) => r.kind === "same")
      .map((r) => [r.oldLine, r.newLine]),
  ).toEqual([
    [1, 1],
    [3, 3],
  ]);
});

it("bounds the matrix and labels large replacement blocks without precise totals", () => {
  const before = [
    "P",
    ...Array.from({ length: 1100 }, (_, i) => `old-${i}`),
    "S",
  ].join("\n");
  const after = [
    "P",
    ...Array.from({ length: 1100 }, (_, i) => `new-${i}`),
    "S",
  ].join("\n");
  const result = compareLines(before, after);
  expect(result.precision).toBe("replacement");
  expect(result.stats).toBeNull();
  expect(
    result.rows.filter((r) => r.kind === "same").map((r) => r.text),
  ).toEqual(["P", "S"]);
  expect(
    result.rows
      .filter((r) => r.oldLine !== null)
      .map((r) => r.text)
      .join("\n"),
  ).toBe(before);
  expect(
    result.rows
      .filter((r) => r.newLine !== null)
      .map((r) => r.text)
      .join("\n"),
  ).toBe(after);
});

it("accepts exactly the character budget and refuses one more without producing partial rows", () => {
  const text = "a".repeat(DIFF_LIMITS.characters);
  expect(compareLines("", text).stats).toEqual({ adds: 1, removes: 0 });
  expect(compareLines("", text + "b")).toEqual({
    precision: "unavailable",
    rows: [],
    stats: null,
    endingChanges: [],
    reason: "characters",
  });
});

it("counts both sides in the physical-row budget and allows a final terminator", () => {
  const text = "a\n".repeat(DIFF_LIMITS.lines / 2);
  expect(compareLines(text, text).stats).toEqual({ adds: 0, removes: 0 });
  expect(compareLines(text, text + "b").reason).toBe("lines");
  expect(compareLines("", "a\n".repeat(DIFF_LIMITS.lines)).stats).toEqual({
    adds: DIFF_LIMITS.lines,
    removes: 0,
  });
});

it("compares long common-prefix row bodies by exact identity without collision shortcuts", () => {
  const prefix = "a".repeat(700);
  const before = Array.from({ length: 998 }, (_, i) => `${prefix}old${i}`).join(
    "\n",
  );
  const after = Array.from({ length: 998 }, (_, i) => `${prefix}new${i}`).join(
    "\n",
  );
  expect(compareLines(before, after).stats).toEqual({
    adds: 998,
    removes: 998,
  });
});

it("reuses a stable owner result but invalidates changes and never aliases another owner", () => {
  const owner = { oldText: "old", newText: "new" };
  const first = comparisonFor(owner);
  expect(comparisonFor(owner)).toBe(first);
  owner.newText = "old";
  expect(comparisonFor(owner)).not.toBe(first);
  expect(comparisonFor(owner).stats).toEqual({ adds: 0, removes: 0 });
  expect(comparisonFor({ ...owner })).not.toBe(comparisonFor(owner));
});

it("copies precision and shifted ending changes while raw sides remain original", () => {
  const before = "a\nb",
    after = "X\na\r\nb";
  const text = comparisonCopy(compareLines(before, after), before, after, true);
  expect(text).toContain("所示片段 · 新增 1 行、删除 0 行");
  expect(text).toContain("修改前 片段第 1 行");
  expect(text).toContain("修改后 片段第 2 行");
  expect(text).toContain("CRLF");
  const missing = comparisonCopy(compareLines(null, "new"), null, "new", true);
  expect(missing).toContain("缺少修改前文本");
  expect(missing).not.toContain("+new");
});

it("retains both raw sides in unavailable comparison copies, never a partial diff", () => {
  const before = "A".repeat(DIFF_LIMITS.characters),
    after = "B\r\n";
  const text = comparisonCopy(compareLines(before, after), before, after, true);
  expect(text).toContain("未完整比较");
  expect(text).toContain(before);
  expect(text.endsWith(after)).toBe(true);
});
