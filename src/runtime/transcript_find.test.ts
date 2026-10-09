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
