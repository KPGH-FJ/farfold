import { describe, expect, it } from "vitest";
import {
  DOCUMENT_INPUT_MAX_BYTES,
  parseApprovedDocumentText,
  parseLocalDocumentText,
} from "./document_input_types";
import { PDF_INPUT_LIMITS } from "./pdf_input_types";
import { pdfLocal } from "./pdf_document.test-support";

const text = "完整保留的提取文字 😀";
describe("independent strict PDF metadata", () => {
  it("clones complete scope and warnings; 32MiB source is PDF-only", () => {
    const value = { text, local: pdfLocal(text) };
    value.local.source.size = PDF_INPUT_LIMITS.sourceBytes;
    const parsed = parseApprovedDocumentText(value);
    expect(parsed).toEqual(value);
    value.local.scope.readPageNumbers.pop();
    value.local.warnings.pop();
    expect(parsed.local?.format).toBe("pdf");
    if (parsed.local?.format !== "pdf") throw new Error("format");
    expect(parsed.local.scope.readPageNumbers).toEqual([1, 2, 3]);
    expect(parsed.local.warnings).toHaveLength(4);
    expect(parsed.local).not.toHaveProperty("imageReferences");
  });
  it.each([
    { ...pdfLocal(), schema: 2 },
    { ...pdfLocal(), selection: "read-visible-text" },
    { ...pdfLocal(), selection: "read-saved-cell-content" },
    { ...pdfLocal(), partial: false },
    { ...pdfLocal(), partialSelected: false },
    { ...pdfLocal(), imageReferences: 0 },
    { ...pdfLocal(), password: "never retained" },
    { ...pdfLocal(), scope: undefined },
    { ...pdfLocal(), scope: { ...pdfLocal().scope, mode: "visible-text" } },
    {
      ...pdfLocal(),
      scope: { ...pdfLocal().scope, includePossiblyInvisibleText: false },
    },
    { ...pdfLocal(), scope: { ...pdfLocal().scope, extraction: "preview" } },
    { ...pdfLocal(), scope: { ...pdfLocal().scope, pageCount: 0 } },
    { ...pdfLocal(), scope: { ...pdfLocal().scope, pageCount: 1001 } },
    { ...pdfLocal(), scope: { ...pdfLocal().scope, readPageNumbers: [1, 3] } },
    {
      ...pdfLocal(),
      scope: { ...pdfLocal().scope, readPageNumbers: [1, 2, 2] },
    },
    {
      ...pdfLocal(),
      scope: { ...pdfLocal().scope, readPageNumbers: [3, 2, 1] },
    },
    { ...pdfLocal(), scope: { ...pdfLocal().scope, viewport: 4 } },
    { ...pdfLocal(), warnings: [] },
    { ...pdfLocal(), warnings: [...pdfLocal().warnings].reverse() },
    {
      ...pdfLocal(),
      warnings: [{ code: "continuousLayout", count: 1 }],
    },
    {
      ...pdfLocal(),
      warnings: [
        ...pdfLocal().warnings,
        { code: "pagesWithoutText", count: 4, unit: "pages" },
      ],
    },
    {
      ...pdfLocal(),
      source: { ...pdfLocal().source, size: PDF_INPUT_LIMITS.sourceBytes + 1 },
    },
    { ...pdfLocal(), utf8Bytes: text.length },
  ])("rejects incomplete scope, mixed schemas or implied approval", (local) => {
    expect(() => parseApprovedDocumentText({ text, local })).toThrow();
  });
  it("can retain a partial review without approving it and distinguishes known/unknown budgets", () => {
    const review = { ...pdfLocal(), partialSelected: false };
    expect(parseLocalDocumentText(review)?.partialSelected).toBe(false);
    const large = "界".repeat(DOCUMENT_INPUT_MAX_BYTES / 2);
    expect(() =>
      parseApprovedDocumentText({ text: large, local: pdfLocal(large) }),
    ).toThrow();
    expect(parseApprovedDocumentText({ text: large, local: null })).toEqual({
      text: large,
      local: null,
    });
  });
});
