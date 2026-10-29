import { expect, it } from "vitest";
import { textMatchOffsets, segmentedMatches } from "./transcript_find";
it("finds each occurrence rather than counting only a matching message", () => {
  expect(textMatchOffsets("Farfold: farfold → FARFOLD", " farfold ")).toEqual([
    0, 9, 19,
  ]);
  expect(textMatchOffsets("检查正文。检查正文", "检查")).toEqual([0, 5]);
});
it("keeps empty, unmatched and overlapping searches finite", () => {
  expect(textMatchOffsets("aaaa", "aa")).toEqual([0, 2]);
  expect(textMatchOffsets("draft", "  ")).toEqual([]);
  expect(textMatchOffsets("draft", "different")).toEqual([]);
});

it("maps one phrase across inline formatting into exact text node boundaries", () => {
  expect(
    segmentedMatches(["Review ", "Farf", "old", " now Farfold"], "Farfold"),
  ).toEqual([
    { startIndex: 1, startOffset: 0, endIndex: 2, endOffset: 3 },
    { startIndex: 3, startOffset: 5, endIndex: 3, endOffset: 12 },
  ]);
});

it("keeps original UTF-16 positions after characters with length-changing case mappings", () => {
  expect(textMatchOffsets("İstanbul Farfold", "farfold")).toEqual([9]);
  expect(segmentedMatches(["İstanbul ", "Farfold"], "farfold")).toEqual([
    { startIndex: 1, startOffset: 0, endIndex: 1, endOffset: 7 },
  ]);
  expect(textMatchOffsets("a+b a.b [x]", "a+b")).toEqual([0]);
  expect(textMatchOffsets("😀 FARFOLD", "farfold")).toEqual([3]);
});

it.each([
  {
    name: "observed emoji prefix",
    text: "附件已加载专用词：星河🙂；字面符号 A+B?[x].*",
    query: "A+B?[x].*",
    expected: [19],
  },
  {
    name: "observed emoji prefix with trailing space",
    text: "附件已加载专用词：星河🙂；字面符号 A+B?[x].* ",
    query: "A+B?[x].*",
    expected: [19],
  },
  {
    name: "same prefix without the emoji",
    text: "附件已加载专用词：星河；字面符号 A+B?[x].*",
    query: "A+B?[x].*",
    expected: [17],
  },
  {
    name: "literal anchors on multiple lines",
    text: "第一行 ^/$\n第二行 ^/$",
    query: "^/$",
    expected: [4, 12],
  },
  {
    name: "literal anchors surrounding an embedded line break",
    text: "x^\n$y\n^\n$",
    query: "^\n$",
    expected: [1, 6],
  },
  {
    name: "Unicode long-s case folding",
    text: "ſ s S",
    query: "s",
    expected: [0, 2, 4],
  },
  {
    name: "Unicode Kelvin-sign case folding",
    text: "K k K",
    query: "k",
    expected: [0, 2, 4],
  },
  {
    name: "non-BMP Deseret case folding",
    text: "𐐀 𐐨 𐐀",
    query: "𐐨",
    expected: [0, 3, 6],
  },
  {
    name: "complete emoji code points",
    text: "前🙂中🙂后",
    query: "🙂",
    expected: [1, 4],
  },
  {
    name: "no high-surrogate match inside a complete emoji",
    text: "前🙂中🙂后",
    query: "\uD83D",
    expected: [],
  },
  {
    name: "no low-surrogate match inside a complete emoji",
    text: "前🙂中🙂后",
    query: "\uDE42",
    expected: [],
  },
  {
    name: "non-overlapping BMP matches",
    text: "aaaaa",
    query: "aa",
    expected: [0, 2],
  },
  {
    name: "non-overlapping complete emoji pairs",
    text: "🙂🙂🙂",
    query: "🙂🙂",
    expected: [0],
  },
])("keeps literal UTF-16 offsets for $name", ({ text, query, expected }) => {
  expect(textMatchOffsets(text, query)).toEqual(expected);
});

it.each([
  {
    name: "emoji-prefixed punctuation across inline nodes",
    segments: ["附件已加载专用词：星河🙂；字面符号 ", "A+", "B?[x].*"],
    query: "A+B?[x].*",
    expected: [{ startIndex: 1, startOffset: 0, endIndex: 2, endOffset: 7 }],
  },
  {
    name: "literal anchors split across nodes and lines",
    segments: ["第一行 ^", "/$", "\n第二行 ", "^/$"],
    query: "^/$",
    expected: [
      { startIndex: 0, startOffset: 4, endIndex: 1, endOffset: 2 },
      { startIndex: 3, startOffset: 0, endIndex: 3, endOffset: 3 },
    ],
  },
  {
    name: "complete emoji phrase across inline nodes",
    segments: ["前🙂", "中", "🙂后"],
    query: "🙂中🙂",
    expected: [{ startIndex: 0, startOffset: 1, endIndex: 2, endOffset: 2 }],
  },
  {
    name: "Deseret folding preserves each node's two UTF-16 units",
    segments: ["前", "𐐀", " ", "𐐨", "后"],
    query: "𐐨",
    expected: [
      { startIndex: 1, startOffset: 0, endIndex: 1, endOffset: 2 },
      { startIndex: 3, startOffset: 0, endIndex: 3, endOffset: 2 },
    ],
  },
])(
  "maps exact original boundaries for $name",
  ({ segments, query, expected }) => {
    expect(segmentedMatches(segments, query)).toEqual(expected);
  },
);
