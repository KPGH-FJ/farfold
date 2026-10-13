import { describe, expect, it } from "vitest";
import { pdfSearchText } from "./pdf_search_text";
import { searchPdf } from "./attachment_search.pdf.test-support";
import { PDF_INPUT_LIMITS } from "./pdf_input_types";

it("keeps exact original item/page locations and actual UTF-8 without generated text", () => {
  const input = searchPdf([
    ["ITEMLEFT", "ITEMRIGHT", "", "ééfiﬁ中🚀", "PAGELEFT"],
    ["PAGERIGHT"],
  ]);
  const output = pdfSearchText(input);
  expect(
    output.segments.map((s) => [
      s.text,
      s.location.pageNumber,
      s.location.itemIndex,
      s.location.decodedRotation,
    ]),
  ).toEqual([
    ["ITEMLEFT", 1, 0, 0],
    ["ITEMRIGHT", 1, 1, 0],
    ["ééfiﬁ中🚀", 1, 3, 0],
    ["PAGELEFT", 1, 4, 0],
    ["PAGERIGHT", 2, 0, 90],
  ]);
  expect(output.bytes).toBe(
    Buffer.byteLength("ITEMLEFTITEMRIGHTééfiﬁ中🚀PAGELEFTPAGERIGHT"),
  );
  for (const query of [
    "ITEMLEFTITEMRIGHT",
    "PAGELEFTPAGERIGHT",
    "readPageNumbers",
    "decodedRotation",
    "visibilityUnverified",
    "PDF 提取文字",
  ])
    expect(output.segments.some((s) => s.text.includes(query))).toBe(false);
  expect(output.pdf).toMatchObject({
    partial: true,
    scope: { pageCount: 2, readPageNumbers: [1, 2] },
  });
});
it("does not conflate composed/decomposed Unicode, ligature or generated whitespace", () => {
  const output = pdfSearchText(
    searchPdf([["é", "é", "fi", "ﬁ", "中🚀", "  tail "]]),
  );
  expect(output.segments.map((s) => s.text)).toEqual([
    "é",
    "é",
    "fi",
    "ﬁ",
    "中🚀",
    "  tail ",
  ]);
  expect(output.bytes).toBe(2 + 3 + 2 + 3 + 7 + 7);
});
it.each([{ pages: [[]] }, { pages: [["", " \t\n"]] }])(
  "reports an empty extracted scope without calling the whole file empty",
  ({ pages }) => {
    expect(() => pdfSearchText(searchPdf(pages))).toThrow();
    try {
      pdfSearchText(searchPdf(pages));
    } catch (e) {
      expect(e).toEqual({ code: "pdfNoText" });
    }
  },
);
it("keeps empty-page warnings and independent immutable location/scope objects", () => {
  const input = searchPdf([["needle"], []]);
  const output = pdfSearchText(input);
  input.pages[0].items[0].text = "different";
  input.scope.readPageNumbers[0] = 100;
  input.warnings[0].count = 3 as 1;
  expect(output.segments[0].text).toBe("needle");
  expect(output.pdf.scope.readPageNumbers).toEqual([1, 2]);
  expect(output.pdf.warnings.at(-1)).toEqual({
    code: "pagesWithoutText",
    count: 1,
    unit: "pages",
  });
  expect(Object.isFrozen(output.segments[0].location)).toBe(true);
  expect(Object.isFrozen(output.pdf.scope.readPageNumbers)).toBe(true);
});
describe("PDF scope and whole-result validation", () => {
  it.each([
    (v: ReturnType<typeof searchPdf>) => {
      v.partial = false as true;
    },
    (v: ReturnType<typeof searchPdf>) => {
      v.scope.includePossiblyInvisibleText = false as true;
    },
    (v: ReturnType<typeof searchPdf>) => {
      v.scope.readPageNumbers = [2];
    },
    (v: ReturnType<typeof searchPdf>) => {
      v.pages[0].number = 2;
    },
    (v: ReturnType<typeof searchPdf>) => {
      v.pages[0].decodedRotation = 1 as 0;
    },
    (v: ReturnType<typeof searchPdf>) => {
      v.warnings = [];
    },
    (v: ReturnType<typeof searchPdf>) => {
      v.pages[0].items[0].text = "\ud800";
    },
  ])(
    "rejects malformed or broadened scope rather than manufacturing a search result",
    (mutate) => {
      const value = searchPdf();
      mutate(value);
      expect(() => pdfSearchText(value)).toThrow();
    },
  );
  it("retains the original complete representation cap, not a per-page truncated prefix", () => {
    const input = searchPdf([["A".repeat(150_000)], ["B".repeat(150_000)]]);
    expect(() => pdfSearchText(input)).toThrow("textLimit");
    expect(PDF_INPUT_LIMITS.textBytes).toBe(256 * 1024);
  });
});

import handAuthored from "./fixtures/pdf-search/hand-authored-textitems.json";
import type { PdfInputResult } from "./pdf_input_types";
it("matches the independently reviewed hand-authored TextItem model without deriving expected data from parser output", () => {
  const output = pdfSearchText(handAuthored.result as PdfInputResult);
  expect(
    output.segments.map(({ text, location }) => ({
      text,
      pageNumber: location.pageNumber,
      itemIndex: location.itemIndex,
      decodedRotation: location.decodedRotation,
    })),
  ).toEqual(handAuthored.expectedNonemptySegments);
  expect(output.bytes).toBe(handAuthored.expectedUtf8Bytes);
  expect(output.bytes).toBe(63);
  for (const query of handAuthored.negativeQueries)
    expect(output.segments.some((s) => s.text.includes(query))).toBe(false);
});
