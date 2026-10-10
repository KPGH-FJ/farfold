import { expect, it } from "vitest";
import type { DocxParagraph, DocxPreview, DocxTable } from "./docx_types";
import {
  DOCUMENT_READING_WINDOW_LIMIT,
  DocumentReadingWindows,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "./preview_reading_position";

const file = {
  root: "/work",
  path: "/work/a.docx",
  resolvedPath: "/work/a.docx",
  name: "a.docx",
  version: "v1",
  sha256: "a".repeat(64),
  size: 100,
};
const paragraph = (
  n = 0,
  length = 40001,
  part = "word/document.xml",
): DocxParagraph => ({
  kind: "paragraph",
  id: "same-display-id",
  source: { part, elementPath: [0, n] },
  style: {},
  runs: [{ kind: "text", style: {}, text: "x".repeat(length) }],
});
const table = (rows = 21, columns = 13): DocxTable => ({
  kind: "table",
  id: "table",
  source: { part: "word/document.xml", elementPath: [0, 1] },
  columnsPt: Array(columns).fill(20),
  rows: Array.from({ length: rows }, () => ({ cells: [] })),
});
const document = (
  blocks: DocxPreview["blocks"],
  value = file,
): DocxPreview => ({
  file: value,
  blocks,
  stories: [],
  images: [],
  warnings: [],
  partial: false,
});

it("stores independent original part/path positions and preserves existing section data", () => {
  const a = paragraph(),
    b = paragraph(0, 40001, "word/header1.xml"),
    t = table();
  const ref: PreviewReadingPositionRef = { current: null };
  const first = new DocumentReadingWindows(document([a, b, t]), ref);
  first.activate();
  first.save(a, { kind: "paragraph", part: 1 });
  first.save(t, { kind: "table", row: 20, column: 12 });
  saveReadingPosition(ref, file, { kind: "document", story: null, segment: 3 });
  const second = new DocumentReadingWindows(document([a, b, t]), ref);
  second.activate();
  expect(second.paragraph(a)).toBe(1);
  expect(second.paragraph(b)).toBe(0);
  expect(second.table(t)).toMatchObject({ row: 20, column: 12 });
  expect(ref.current).toMatchObject({ segment: 3 });
  expect([...ref.documentWindows!.positions.values()]).toEqual([
    { kind: "paragraph", part: 1 },
    { kind: "table", row: 20, column: 12 },
  ]);
});
it("new snapshot removes absent or different-kind paths and clamps remaining coordinates", () => {
  const a = paragraph(),
    t = table(),
    gone = paragraph(9);
  const ref: PreviewReadingPositionRef = { current: null };
  const first = new DocumentReadingWindows(document([a, t, gone]), ref);
  first.activate();
  first.save(a, { kind: "paragraph", part: 1 });
  first.save(t, { kind: "table", row: 20, column: 12 });
  first.save(gone, { kind: "paragraph", part: 1 });
  const short = paragraph(0, 5),
    small = table(3, 2);
  const second = new DocumentReadingWindows(
    document([short, small], { ...file, version: "v2" }),
    ref,
  );
  second.activate();
  expect(second.paragraph(short)).toBe(0);
  expect(second.table(small)).toMatchObject({ row: 0, column: 0 });
  expect(ref.documentWindows!.positions.size).toBe(2);
  const changedKind = { ...small, source: short.source };
  const third = new DocumentReadingWindows(document([changedKind]), ref);
  third.activate();
  expect(ref.documentWindows!.positions.size).toBe(0);
});
it("old owner writes and cleanup cannot replace or release the current owner", () => {
  const a = paragraph(),
    ref: PreviewReadingPositionRef = { current: null };
  const old = new DocumentReadingWindows(document([a]), ref),
    leave = old.activate();
  const current = new DocumentReadingWindows(document([a]), ref);
  current.activate();
  old.save(a, { kind: "paragraph", part: 1 });
  expect(ref.documentWindows!.positions.size).toBe(0);
  leave();
  current.save(a, { kind: "paragraph", part: 1 });
  expect(current.paragraph(a)).toBe(1);
  current.save({ ...a }, { kind: "paragraph", part: 0 });
  expect(current.paragraph(a)).toBe(1);
});
it("different root or resolved path never borrows windows even with identical block paths", () => {
  const a = paragraph(),
    ref: PreviewReadingPositionRef = { current: null };
  const old = new DocumentReadingWindows(document([a]), ref);
  old.activate();
  old.save(a, { kind: "paragraph", part: 1 });
  for (const next of [
    { ...file, root: "/other" },
    { ...file, resolvedPath: "/work/b.docx" },
  ]) {
    const current = new DocumentReadingWindows(document([a], next), ref);
    expect(current.paragraph(a)).toBe(0);
  }
});
it("stores at most128 recent coordinates without content or unlimited file history", () => {
  const blocks = Array.from({ length: 129 }, (_, n) => paragraph(n));
  const ref: PreviewReadingPositionRef = { current: null };
  const current = new DocumentReadingWindows(document(blocks), ref);
  current.activate();
  for (const p of blocks) current.save(p, { kind: "paragraph", part: 1 });
  expect(ref.documentWindows!.positions.size).toBe(
    DOCUMENT_READING_WINDOW_LIMIT,
  );
  expect(current.paragraph(blocks[0])).toBe(0);
  expect(current.paragraph(blocks[128])).toBe(1);
  expect(
    [...ref.documentWindows!.positions.values()].every(
      (v) => Object.keys(v).sort().join(",") === "kind,part",
    ),
  ).toBe(true);
});
it("invalid numbers are reset before storing or using a viewport", () => {
  const a = paragraph(),
    t = table(),
    ref: PreviewReadingPositionRef = { current: null };
  const current = new DocumentReadingWindows(document([a, t]), ref);
  current.activate();
  current.save(a, { kind: "paragraph", part: Infinity });
  current.save(t, { kind: "table", row: NaN, column: 1.5 });
  expect(current.paragraph(a)).toBe(0);
  expect(current.table(t)).toMatchObject({ row: 0, column: 0 });
});
