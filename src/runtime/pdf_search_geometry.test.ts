import { expect, it } from "vitest";
import { pdfSearchText, pdfSearchMatchLocation } from "./pdf_search_text";
import { attachmentSearchLocationLabel } from "./attachment_search_strings";
import { searchPdf } from "./attachment_search.pdf.test-support";
import type { PdfInputTextItem } from "./pdf_input_types";

function item(text: string, x: number, width = 10): PdfInputTextItem {
  return {
    text,
    dir: "ltr",
    hasEOL: false,
    geometry: { transform: [12, 0, 0, 12, x, 100], width, height: 12 },
  };
}
function input(items: PdfInputTextItem[]) {
  const result = searchPdf([items.map((i) => i.text)]);
  result.pages[0].items = items;
  return result;
}
function matches(items: PdfInputTextItem[], query = "needle") {
  return pdfSearchText(input(items)).segments.flatMap((s) => [
    ...s.text.matchAll(new RegExp(query, "gu")),
  ]);
}
it("joins exact adjacent baseline fragments once, preserving actual spaces and bytes", () => {
  const result = pdfSearchText(
    input([
      item("need", 10, 20),
      item("le", 30),
      item(" ", 40, 5),
      item("tail", 45),
    ]),
  );
  expect(result.segments.map((s) => s.text)).toEqual(["needle tail"]);
  expect(result.segments[0].pdfSpans).toEqual([
    { itemIndex: 0, start: 0, end: 4 },
    { itemIndex: 1, start: 4, end: 6 },
    { itemIndex: 2, start: 6, end: 7 },
    { itemIndex: 3, start: 7, end: 11 },
  ]);
  expect(result.bytes).toBe(11);
  expect([...result.segments[0].text.matchAll(/need/gu)]).toHaveLength(1);
  expect(
    matches([item("need", 10, 20), item("le", 30 + Number.EPSILON * 64)]),
  ).toHaveLength(1);
});
it.each([
  [
    "missing geometry",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      delete b.geometry;
    },
  ],
  [
    "line end",
    (a: PdfInputTextItem) => {
      a.hasEOL = true;
    },
  ],
  [
    "different baseline",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[5] = 90;
    },
  ],
  [
    "column gap",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[4] = 150;
    },
  ],
  [
    "small real gap",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[4] += 0.001;
    },
  ],
  [
    "overlap",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[4] -= 0.001;
    },
  ],
  [
    "different scale",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[0] = 13;
    },
  ],
  [
    "different height",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.height = 13;
    },
  ],
  [
    "RTL",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.dir = "rtl";
    },
  ],
  [
    "vertical text",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.dir = "ttb";
    },
  ],
  [
    "skew",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[2] = 0.01;
    },
  ],
  [
    "rotated transform",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform = [0, 12, -12, 0, 30, 100];
    },
  ],
  [
    "mirrored",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      b.geometry!.transform[0] = -12;
    },
  ],
  [
    "zero advance",
    (a: PdfInputTextItem) => {
      a.geometry!.width = 0;
    },
  ],
  [
    "overflowing endpoint",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      a.geometry!.transform[4] = Number.MAX_VALUE;
      a.geometry!.width = Number.MAX_VALUE;
      b.geometry!.transform[4] = Number.MAX_VALUE;
    },
  ],
  [
    "lost advance at enormous origin",
    (a: PdfInputTextItem, b: PdfInputTextItem) => {
      a.geometry!.transform[4] = 1e30;
      b.geometry!.transform[4] = 1e30;
    },
  ],
] as const)("keeps %s as separate searchable fragments", (_name, mutate) => {
  const a = item("need", 10, 20),
    b = item("le", 30);
  mutate(a, b);
  expect(matches([a, b])).toHaveLength(0);
  expect(matches([a, b], "need")).toHaveLength(1);
});
it.each([90, 180, 270] as const)(
  "does not join a page rotated %s degrees",
  (rotation) => {
    const result = input([item("need", 10, 20), item("le", 30)]);
    result.pages[0].decodedRotation = rotation;
    expect(pdfSearchText(result).segments.map((s) => s.text)).toEqual([
      "need",
      "le",
    ]);
  },
);
it("does not reorder extraction items or cross empty EOL, explicit newline or page boundaries", () => {
  expect(matches([item("le", 30), item("need", 10, 20)])).toHaveLength(0);
  const empty = { text: "", dir: "ltr" as const, hasEOL: true };
  const separated = pdfSearchText(
    input([item("need", 10, 20), empty, item("le", 30)]),
  );
  expect(separated.segments.map((s) => s.location.itemIndex)).toEqual([0, 2]);
  expect(separated.segments.map((s) => s.text)).toEqual(["need", "le"]);
  expect(matches([item("need\n", 10, 20), item("le", 30)])).toHaveLength(0);
  const pages = searchPdf([["need"], ["le"]]);
  pages.pages[0].items = [item("need", 10, 20)];
  pages.pages[1].items = [item("le", 30)];
  expect(pdfSearchText(pages).segments.map((s) => s.text)).toEqual([
    "need",
    "le",
  ]);
});
it("maps only matched original UTF-16 ranges, preserving the single-item location shape", () => {
  const result = pdfSearchText(input([item("x😀e", 10, 20), item("́tail", 30)]));
  const segment = result.segments[0];
  expect(segment.text).toBe("x😀étail");
  const location = pdfSearchMatchLocation(
    segment.location,
    segment.pdfSpans,
    1,
    5,
  );
  expect(location).toEqual({
    kind: "pdf",
    pageNumber: 1,
    decodedRotation: 0,
    itemIndex: 0,
    itemRanges: [
      { itemIndex: 0, start: 1, end: 4 },
      { itemIndex: 1, start: 0, end: 1 },
    ],
  });
  expect(attachmentSearchLocationLabel(location)).toBe(
    "第 1 页 · 提取片段 1至2",
  );
  const single = pdfSearchMatchLocation(
    segment.location,
    segment.pdfSpans,
    5,
    9,
  );
  expect(single).toEqual({
    kind: "pdf",
    pageNumber: 1,
    decodedRotation: 0,
    itemIndex: 1,
  });
  expect(attachmentSearchLocationLabel(single)).toBe("第 1 页 · 提取片段 2");
});
