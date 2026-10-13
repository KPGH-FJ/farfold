import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalPdfDocumentText } from "../runtime/document_input_types";
import {
  DOCUMENT_INPUT_STRINGS as S,
  documentInputFailure,
} from "../runtime/document_input_strings";
import { PDF_INPUT_SCOPE_TEXT } from "../runtime/pdf_input_text";
vi.mock("./WorkspaceDialog", () => ({
  WorkspaceDialog: ({ children }: { children: React.ReactNode }) => children,
}));
import { DocumentInputReview } from "./DocumentInputReview";
import { DocumentTextDetails } from "./DocumentTextDetails";

const text = `${"decoded text ".repeat(3500)}<script>LAST_PAGE_WHOLE_TAIL</script>`;
const local: LocalPdfDocumentText = {
  schema: 1,
  format: "pdf",
  selection: "read-decoded-page-text",
  source: {
    root: "/owned",
    path: "/owned/report.pdf",
    resolvedPath: "/owned/report.pdf",
    name: "report.pdf",
    size: 100,
    sha256: "a".repeat(64),
    version: "pdf-version",
  },
  textSha256: "b".repeat(64),
  utf8Bytes: new TextEncoder().encode(text).byteLength,
  partial: true,
  partialSelected: true,
  scope: {
    mode: "decoded-page-text",
    includePossiblyInvisibleText: true,
    pageCount: 3,
    readPageNumbers: [1, 2, 3],
    extraction: "pdfjs-text-content-v1",
  },
  warnings: [
    { code: "decodedTextOnly", count: 1, unit: "scope" },
    { code: "visibilityUnverified", count: 1, unit: "scope" },
    { code: "readingOrderUnverified", count: 1, unit: "scope" },
    { code: "textDecodingUnverified", count: 1, unit: "scope" },
    { code: "pagesWithoutText", count: 1, unit: "pages" },
  ],
};
const defaults = {
  name: "report.pdf",
  partialSelected: false,
  onPartialSelected: () => {},
  busy: null,
  error: null,
  onConfirm: () => {},
  onClose: () => {},
} as const;
it("shows explicit possible-invisible range choice before extraction with no new text and an initially disabled read", () => {
  const html = renderToStaticMarkup(
    <DocumentInputReview
      {...defaults}
      result={null}
      pdfScopeRequired
      pdfScopeSelected={false}
      onPdfScopeSelected={() => {}}
      onReadPdf={() => {}}
    />,
  );
  for (const warning of Object.values(PDF_INPUT_SCOPE_TEXT))
    expect(html).toContain(warning);
  expect(html).toContain(S.pdfInvisibleConsent);
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(html).toMatch(/disabled=""[^>]*>读取此范围的文字/);
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain(S.confirmPartial);
  expect(html).not.toContain(S.scope);
});
it("preserves full last-page text and four fixed limits while keeping omission consent unchecked despite the old confirmed scope", () => {
  const html = renderToStaticMarkup(
    <DocumentInputReview
      {...defaults}
      result={{ text, local, actualTextChars: text.length }}
      pdfRequest={{
        mode: local.scope.mode,
        includePossiblyInvisibleText: true,
      }}
    />,
  );
  for (const warning of Object.values(PDF_INPUT_SCOPE_TEXT))
    expect(html).toContain(warning);
  expect(html).toContain(S.pdfPageCount(3));
  expect(html).toContain(S.pdfPagesWithoutText);
  expect(html).toContain("1 页");
  expect(html).toContain("&lt;script&gt;LAST_PAGE_WHOLE_TAIL&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(html).toMatch(/disabled=""[^>]*>只加入已读取文字/);
  expect(html).not.toContain(S.xlsxScope);
  expect(html).not.toContain("undefined");
});
it("readonly confirmed PDF view shows the original scope, full text and limits without any new agreement or actions", () => {
  const html = renderToStaticMarkup(
    <DocumentTextDetails document={{ text, local }} />,
  );
  expect(html).toContain(S.pdfSavedScope);
  expect(html).toContain(S.pdfDecodedText);
  expect(html).toContain(S.pdfPageCount(3));
  for (const warning of Object.values(PDF_INPUT_SCOPE_TEXT))
    expect(html).toContain(warning);
  expect(html).toContain("LAST_PAGE_WHOLE_TAIL");
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("<button");
  expect(html).not.toContain(S.pdfInvisibleConsent);
  expect(html).not.toContain(S.xlsxSavedScope);
});
it("unknown historical PDF text remains readonly without fabricated scope or authority", () => {
  const html = renderToStaticMarkup(
    <DocumentTextDetails
      document={{ text: "UNKNOWN_WHOLE_TEXT", local: null }}
    />,
  );
  expect(html).toContain("UNKNOWN_WHOLE_TEXT");
  expect(html).toContain(S.restored);
  expect(html).not.toContain(S.pdfSavedScope);
  expect(html).not.toContain(S.sourceVersion);
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("<button");
});
it("uses safe shared messages for missing scope and incomplete parsing without library diagnostics", () => {
  expect(
    documentInputFailure({
      code: "scopeRequired",
      message: "private raw library detail",
    }),
  ).toBe(S.pdfScopeRequired);
  expect(
    documentInputFailure({
      code: "incomplete",
      message: "private raw library detail",
    }),
  ).toBe(S.pdfIncomplete);
  expect(documentInputFailure({ code: "incomplete" })).not.toContain("private");
});
