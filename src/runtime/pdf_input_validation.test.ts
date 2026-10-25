import { expect, it } from "vitest";
import {
  checkedPdfInputRequest,
  checkedPdfInputScope,
  checkedPdfInputWarnings,
  checkedPdfInputResult,
  pdfInputUtf8,
} from "./pdf_input_validation";
import { PDF_INPUT_LIMITS } from "./pdf_input_types";
import { pdfRequest, pdfResult } from "./pdf_input_fixture.test-support";

it.each([
  undefined,
  null,
  {},
  { mode: "decoded-page-text" },
  { ...pdfRequest, includePossiblyInvisibleText: false },
])("requires an affirmative scope before parsing: %j", (value) => {
  expect(() => checkedPdfInputRequest(value)).toThrow("scopeRequired");
});
it("rejects a different range or extra authority fields", () => {
  for (const value of [
    { ...pdfRequest, mode: "visible" },
    { ...pdfRequest, confirmed: true },
    { ...pdfRequest, source: {} },
  ])
    expect(() => checkedPdfInputRequest(value)).toThrow("invalid");
  expect(checkedPdfInputRequest(pdfRequest)).toEqual(pdfRequest);
});
it.each(
  [[1], [1, 1, 3], [1, 3, 2], [0, 1, 2], [1, 2, 4]].map((readPageNumbers) => ({
    readPageNumbers,
  })),
)(
  "refuses prefix, repeated, reordered or skipped page numbers $readPageNumbers",
  ({ readPageNumbers }) => {
    expect(() =>
      checkedPdfInputScope({ ...pdfResult("x", 3).scope, readPageNumbers }),
    ).toThrow("invalid");
  },
);
it("retains all one-based pages, without broadening a forged scope", () => {
  const scope = pdfResult("x", 1000).scope;
  expect(checkedPdfInputScope(scope)).toEqual(scope);
  expect(() => checkedPdfInputScope({ ...scope, pageCount: 1001 })).toThrow(
    "invalid",
  );
  expect(() =>
    checkedPdfInputScope({ ...scope, extraction: "visual" }),
  ).toThrow("invalid");
});
it("requires the four canonical truthful warnings, closed codes and actual count units", () => {
  const warnings = pdfResult().warnings;
  for (const value of [
    warnings.slice(1),
    [...warnings].reverse(),
    [...warnings, warnings[0]],
    warnings.map((w, i) => (i ? w : { ...w, count: 2 })),
    warnings.map((w, i) => (i ? w : { ...w, unit: "pages" })),
    warnings.map((w, i) => (i ? w : { ...w, code: "complete" })),
    [...warnings, { code: "pagesWithoutText", count: 0, unit: "pages" }],
    [...warnings, { code: "pagesWithoutText", count: 1001, unit: "pages" }],
  ])
    expect(() => checkedPdfInputWarnings(value)).toThrow("invalid");
});
it("strictly validates all structure instead of accepting a good first page", () => {
  const good = pdfResult("x", 2);
  for (const bad of [
    { ...good, partial: false },
    { ...good, complete: true },
    { ...good, pages: good.pages.slice(0, 1) },
    { ...good, pages: [good.pages[0], { ...good.pages[1], number: 1 }] },
    {
      ...good,
      pages: [good.pages[0], { ...good.pages[1], decodedRotation: 45 }],
    },
    {
      ...good,
      pages: [
        good.pages[0],
        {
          ...good.pages[1],
          items: [{ text: "x", dir: "ltr", hasEOL: false, visible: true }],
        },
      ],
    },
    {
      ...good,
      pages: [
        good.pages[0],
        {
          ...good.pages[1],
          items: [{ text: "x", dir: "invalid", hasEOL: false }],
        },
      ],
    },
  ])
    expect(() => checkedPdfInputResult(bad)).toThrow("invalid");
  expect(checkedPdfInputResult(good)).toEqual(good);
});
it("counts truly textless pages rather than generated page labels or empty item markers", () => {
  const good = pdfResult(" \t\n", 2);
  expect(checkedPdfInputResult(good).warnings.at(-1)).toEqual({
    code: "pagesWithoutText",
    count: 2,
    unit: "pages",
  });
  expect(() =>
    checkedPdfInputResult({ ...good, warnings: good.warnings.slice(0, 4) }),
  ).toThrow("invalid");
  expect(() =>
    checkedPdfInputResult({
      ...good,
      warnings: [
        ...good.warnings.slice(0, 4),
        { code: "pagesWithoutText", count: 1, unit: "pages" },
      ],
    }),
  ).toThrow("invalid");
});
it("applies global UTF-8, item and structure budgets without resetting for each page", () => {
  expect(() => checkedPdfInputResult(pdfResult("a".repeat(150000), 2))).toThrow(
    "textLimit",
  );
  const tooMany = pdfResult();
  tooMany.pages[0].items = Array(100001).fill({
    text: "",
    dir: "ltr",
    hasEOL: false,
  });
  expect(() => checkedPdfInputResult(tooMany)).toThrow("limit");
  const expanded = pdfResult();
  expanded.pages[0].items = Array(7000).fill({
    text: "x",
    dir: "ltr",
    hasEOL: false,
  });
  expect(() => checkedPdfInputResult(expanded)).toThrow("textLimit");
});
it("preserves Unicode scalars without replacement, normalization or a per-character byte guess", () => {
  expect(pdfInputUtf8("fiﬁ中🚀")).toEqual(new TextEncoder().encode("fiﬁ中🚀"));
  for (const bad of ["\ud800", "\udc00", "x\ud800z"])
    expect(() => pdfInputUtf8(bad)).toThrow("invalid");
  expect(pdfInputUtf8("a".repeat(PDF_INPUT_LIMITS.textBytes)).length).toBe(
    PDF_INPUT_LIMITS.textBytes,
  );
  expect(() =>
    pdfInputUtf8("a".repeat(PDF_INPUT_LIMITS.textBytes + 1)),
  ).toThrow("textLimit");
  expect(() => pdfInputUtf8("中".repeat(90000))).toThrow("textLimit");
});
it.each(["scope", "warnings", "pages", "items"])(
  "rejects sparse %s rather than silently skipping missing structure",
  (kind) => {
    const result = pdfResult("x", 2);
    if (kind === "scope") {
      result.scope.readPageNumbers = new Array(2);
      expect(() => checkedPdfInputScope(result.scope)).toThrow("invalid");
    } else if (kind === "warnings") {
      expect(() => checkedPdfInputWarnings(new Array(4))).toThrow("invalid");
    } else {
      if (kind === "pages") result.pages = new Array(2);
      else {
        result.pages[1].items = new Array(1);
        result.warnings.push({
          code: "pagesWithoutText",
          count: 1,
          unit: "pages",
        });
      }
      expect(() => checkedPdfInputResult(result)).toThrow("invalid");
    }
  },
);
it("copies finite fragment geometry without charging it to the old representation budget", () => {
  const plain = pdfResult("x");
  const overhead = Buffer.byteLength(JSON.stringify(plain)) - 1;
  plain.pages[0].items[0].text = "x".repeat(262144 - overhead);
  expect(Buffer.byteLength(JSON.stringify(plain))).toBe(262144);
  const geometry = {
    transform: [12, 0, 0, 12, 10, 100] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ],
    width: 20,
    height: 12,
  };
  plain.pages[0].items[0].geometry = geometry;
  const checked = checkedPdfInputResult(plain);
  geometry.transform[4] = 999;
  expect(checked.pages[0].items[0].geometry?.transform[4]).toBe(10);
  plain.pages[0].items[0].text += "x";
  expect(() => checkedPdfInputResult(plain)).toThrow("textLimit");
});
it("rejects malformed claimed geometry instead of accepting sparse or non-finite coordinates", () => {
  const good = { transform: [12, 0, 0, 12, 10, 100], width: 20, height: 12 };
  const sparse = Object.assign(Array(6), { extra: 1 });
  sparse[0] = 12;
  for (const geometry of [
    { ...good, transform: Array(6) },
    { ...good, transform: sparse },
    { ...good, transform: [12, 0, 0, 12, 10, Infinity] },
    { ...good, transform: [12, 0, 0, 12, 10, NaN] },
    { ...good, transform: [12, 0, 0, 12, 10, "100"] },
    { ...good, width: -1 },
    { ...good, height: Infinity },
    { ...good, visible: true },
  ]) {
    const value = pdfResult();
    value.pages[0].items[0].geometry = geometry as never;
    expect(() => checkedPdfInputResult(value)).toThrow("invalid");
  }
});
