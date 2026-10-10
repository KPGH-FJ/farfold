import { expect, it } from "vitest";
import { parseDocx } from "./docx_parse";
import { docxFixture } from "./docx_fixture";
import type { VerifiedFile } from "./file_delivery";
import type {
  DocxBlock,
  DocxParagraph,
  DocxPreview,
  DocxTable,
} from "./docx_types";
import {
  createDocumentFeedbackSource,
  documentFeedbackTarget,
  documentFeedbackSourceIsValid,
  documentFeedbackBlockIsEligible,
  retireDocumentFeedbackSource,
  type DocumentFeedbackSourceInput,
} from "./docx_feedback_target";
import {
  officeFeedbackTargetMatches,
  officeFeedbackSourceIsValid,
  retireOfficeFeedbackSource,
  type OfficeTargetConfirmation,
} from "./office_feedback_target";

const file = (): VerifiedFile => ({
  root: "/work",
  path: "/work/document.docx",
  resolvedPath: "/work/document.docx",
  name: "document.docx",
  size: 1024,
  sha256: "a".repeat(64),
  version: "v1",
});
const paragraph = (
  id: string,
  path: number[],
  part = "word/document.xml",
): DocxParagraph => ({
  kind: "paragraph",
  id,
  source: { part, elementPath: path },
  style: {},
  runs: [{ kind: "text", text: "same visible words", style: {} }],
});
function fixture() {
  const p = paragraph("p", [0, 1]);
  const nested = paragraph("nested", [0, 2, 1, 0, 0]);
  const table: DocxTable = {
    kind: "table",
    id: "t",
    source: { part: "word/document.xml", elementPath: [0, 2] },
    columnsPt: [50],
    rows: [
      { cells: [{ column: 0, rowSpan: 1, columnSpan: 1, blocks: [nested] }] },
    ],
  };
  const header = paragraph("header", [0], "word/header1.xml");
  const preview: DocxPreview = {
    file: file(),
    blocks: [p, table],
    stories: [{ id: "story", kind: "header", blocks: [header] }],
    images: [],
    warnings: [{ code: "continuousLayout", count: 1 }],
    partial: false,
  };
  return {
    preview,
    p,
    table,
    nested,
    header,
    input: {
      preview,
      block: p,
      expectedFile: { ...preview.file },
    } satisfies DocumentFeedbackSourceInput,
  };
}
const target = (input: DocumentFeedbackSourceInput) => {
  const source = createDocumentFeedbackSource(input);
  expect(source).not.toBeNull();
  return { source: source!, anchor: documentFeedbackTarget(source!)! };
};

it("shares display eligibility without granting a copied block live ownership", () => {
  const f = fixture();
  const copy = structuredClone(f.p);
  expect(documentFeedbackBlockIsEligible(copy)).toBe(true);
  expect(createDocumentFeedbackSource({ ...f.input, block: copy })).toBeNull();
  expect(
    documentFeedbackBlockIsEligible({
      kind: "notice",
      id: "n",
      code: "hiddenContent",
    }),
  ).toBe(false);
  copy.runs = [{ kind: "notice", code: "hiddenContent" }];
  expect(documentFeedbackBlockIsEligible(copy)).toBe(false);
  copy.runs = [];
  expect(documentFeedbackBlockIsEligible(copy)).toBe(true);
});

it("registers real nested body/table/story objects without inferring identity from text or display id", () => {
  const f = fixture();
  for (const block of [f.p, f.nested, f.table, f.header]) {
    const { source, anchor } = target({ ...f.input, block });
    expect(anchor).toEqual({
      kind: "docx-block",
      ...block.source,
      blockKind: block.kind,
    });
    expect(officeFeedbackTargetMatches({ source, anchor })).toBe(true);
  }
  expect(
    createDocumentFeedbackSource({ ...f.input, block: structuredClone(f.p) }),
  ).toBeNull();
  expect(
    createDocumentFeedbackSource({ ...f.input, block: { ...f.p } }),
  ).toBeNull();
});

it("consumes current actual parser output while ignoring non-output source nodes", () => {
  const preview: DocxPreview = {
    ...parseDocx(docxFixture("07-header-footer-footnote")),
    file: file(),
  };
  const note = preview.stories.find((s) => s.kind === "footnote")!.blocks[0];
  expect(note.kind).toBe("paragraph");
  if (note.kind !== "paragraph") throw new Error("fixture note missing");
  expect(
    target({ preview, block: note, expectedFile: preview.file }).anchor,
  ).toEqual({
    kind: "docx-block",
    blockKind: "paragraph",
    part: "word/footnotes.xml",
    elementPath: [2, 0],
  });
  const fallback = {
    ...parseDocx(docxFixture("16-alternate-content")),
    file: file(),
  };
  const block = fallback.blocks[0] as DocxParagraph;
  expect(
    target({ preview: fallback, block, expectedFile: fallback.file }).anchor
      .elementPath,
  ).toEqual([0, 0, 1, 0]);
  expect(
    createDocumentFeedbackSource({
      preview: fallback,
      expectedFile: fallback.file,
      block: {
        ...block,
        source: { part: "word/document.xml", elementPath: [0, 0, 0, 0, 0] },
      },
    }),
  ).toBeNull();
});

it.each([
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const)("requires matching file receipt field %s", (key) => {
  const f = fixture();
  const expected = {
    ...f.preview.file,
    [key]: key === "size" ? 1025 : "changed",
  };
  expect(
    createDocumentFeedbackSource({ ...f.input, expectedFile: expected }),
  ).toBeNull();
});

it("exposes only a frozen file identity and returns independent anchor arrays", () => {
  const { source, anchor } = target(fixture().input);
  expect(Object.keys(source)).toEqual(["kind", "file"]);
  expect(Object.isFrozen(source)).toBe(true);
  expect(Object.isFrozen(source.file)).toBe(true);
  const second = documentFeedbackTarget(source)!;
  expect(second).toEqual(anchor);
  expect(second.elementPath).not.toBe(anchor.elementPath);
  (anchor.elementPath as number[])[0] = 99;
  expect(documentFeedbackTarget(source)).toEqual(second);
  expect(documentFeedbackTarget({ ...source })).toBeNull();
});

it.each([
  (f: ReturnType<typeof fixture>) => {
    f.preview.file = { ...f.preview.file };
  },
  (f: ReturnType<typeof fixture>) => {
    f.preview.file.version = "v2";
  },
  (f: ReturnType<typeof fixture>) => {
    f.input.expectedFile.sha256 = "b".repeat(64);
  },
  (f: ReturnType<typeof fixture>) => {
    f.p.source = { ...f.p.source };
  },
  (f: ReturnType<typeof fixture>) => {
    f.p.source = { ...f.p.source, elementPath: [...f.p.source.elementPath] };
  },
  (f: ReturnType<typeof fixture>) => {
    (f.p.source.elementPath as number[])[1] = 9;
  },
  (f: ReturnType<typeof fixture>) => {
    f.preview.blocks.shift();
  },
  (f: ReturnType<typeof fixture>) => {
    f.preview.blocks[0] = structuredClone(f.p);
  },
])("rejects target after file/source or membership mutation %#", (mutate) => {
  const f = fixture(),
    { source } = target(f.input);
  mutate(f);
  expect(documentFeedbackTarget(source)).toBeNull();
  expect(officeFeedbackSourceIsValid(source)).toBe(false);
});

it("rejects ambiguous coordinates, duplicate object memberships and cyclic table trees", () => {
  const f = fixture();
  f.preview.blocks.push({ ...f.p, id: "another" });
  expect(createDocumentFeedbackSource(f.input)).toBeNull();
  f.preview.blocks.pop();
  f.preview.stories[0].blocks.push(f.p);
  expect(createDocumentFeedbackSource(f.input)).toBeNull();
  f.preview.stories[0].blocks.pop();
  f.table.rows[0].cells[0].blocks.push(f.table);
  expect(createDocumentFeedbackSource(f.input)).toBeNull();
});

it("permanently retires one identity without retiring a later registration", () => {
  const f = fixture(),
    first = target(f.input);
  retireOfficeFeedbackSource(first.source);
  retireDocumentFeedbackSource(first.source);
  expect(documentFeedbackTarget(first.source)).toBeNull();
  expect(officeFeedbackTargetMatches(first)).toBe(false);
  const second = target(f.input);
  expect(second.source).not.toBe(first.source);
  retireDocumentFeedbackSource(first.source);
  expect(documentFeedbackSourceIsValid(second.source)).toBe(true);
});

it.each(
  [
    [{ kind: "notice", code: "hiddenContent" }],
    [
      { kind: "text", text: "", style: {} },
      { kind: "notice", code: "missingFieldResult" },
    ],
    [{ kind: "notice", code: "unsupportedContent" }],
  ].map((runs) => ({ runs })),
)("rejects omission-only paragraphs: %j", ({ runs }) => {
  const f = fixture();
  f.p.runs = runs as DocxParagraph["runs"];
  expect(createDocumentFeedbackSource(f.input)).toBeNull();
});

it.each(
  [
    [],
    [{ kind: "text", text: "", style: {} }],
    [
      { kind: "text", text: "visible", style: {} },
      { kind: "notice", code: "hiddenContent" },
    ],
    [{ kind: "tab" }, { kind: "notice", code: "hiddenContent" }],
    [{ kind: "break" }, { kind: "notice", code: "unsupportedContent" }],
  ].map((runs) => ({ runs })),
)(
  "accepts empty structural or genuinely visible paragraph without persisting text: %j",
  ({ runs }) => {
    const f = fixture();
    f.p.runs = runs as DocxParagraph["runs"];
    const { anchor } = target(f.input);
    expect(Object.keys(anchor).sort()).toEqual([
      "blockKind",
      "elementPath",
      "kind",
      "part",
    ]);
    expect(f.p.runs).toEqual(runs);
  },
);

it("rejects standalone notice while a whole table remains a structural target", () => {
  const f = fixture();
  const notice: DocxBlock = {
    kind: "notice",
    id: "omitted",
    code: "unsupportedContent",
  };
  f.preview.blocks.push(notice);
  expect(
    createDocumentFeedbackSource({
      ...f.input,
      block: notice as unknown as DocxParagraph,
    }),
  ).toBeNull();
  f.nested.runs = [{ kind: "notice", code: "hiddenContent" }];
  expect(target({ ...f.input, block: f.table }).anchor.blockKind).toBe("table");
  expect(
    createDocumentFeedbackSource({ ...f.input, block: f.nested }),
  ).toBeNull();
});

it("requires correlated DOCX source/anchor and exact coordinates in the shared interface", () => {
  const pair = target(fixture().input);
  expect(officeFeedbackTargetMatches(pair)).toBe(true);
  for (const anchor of [
    { ...pair.anchor, part: "word/header1.xml" },
    { ...pair.anchor, elementPath: [0, 9] },
    { ...pair.anchor, blockKind: "table" },
    { ...pair.anchor, verified: true },
    {
      kind: "xlsx-range",
      sheetId: "rId1",
      sheetName: "s",
      fromRow: 1,
      toRow: 1,
      fromColumn: 1,
      toColumn: 1,
    },
  ])
    expect(
      officeFeedbackTargetMatches({
        ...pair,
        anchor,
      } as OfficeTargetConfirmation),
    ).toBe(false);
  const xlsx = {
    kind: "xlsx-range" as const,
    sheetId: "rId1",
    sheetName: "s",
    fromRow: 1,
    toRow: 1,
    fromColumn: 1,
    toColumn: 1,
  };
  // @ts-expect-error A DOCX source cannot carry a spreadsheet anchor.
  const invalid: OfficeTargetConfirmation = {
    source: pair.source,
    anchor: xlsx,
  };
  expect(officeFeedbackTargetMatches(invalid)).toBe(false);
});
