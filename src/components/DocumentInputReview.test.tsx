import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("./WorkspaceDialog", () => ({
  WorkspaceDialog: ({ children }: { children: React.ReactNode }) => children,
}));
import { DocumentInputReview } from "./DocumentInputReview";
import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";
it("shows the whole selected tail and retained old text, escapes markup, and requires a nonselected partial choice", () => {
  const text = `${"body ".repeat(3000)}<script>tail-value</script>`;
  const html = renderToStaticMarkup(
    <DocumentInputReview
      name="notes.docx"
      result={{
        text,
        actualTextChars: text.length,
        local: {
          schema: 1,
          format: "docx",
          source: {
            root: "/d",
            path: "/d/notes.docx",
            resolvedPath: "/d/notes.docx",
            name: "notes.docx",
            size: 100,
            sha256: "a".repeat(64),
            version: "v",
          },
          textSha256: "b".repeat(64),
          utf8Bytes: text.length,
          selection: "read-visible-text",
          partial: true,
          partialSelected: false,
          warnings: [{ code: "hiddenContent", count: 1 }],
          imageReferences: 2,
        },
      }}
      previousText="Retained previous text"
      partialSelected={false}
      onPartialSelected={() => {}}
      busy={null}
      error={null}
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain("&lt;script&gt;tail-value&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Retained previous text");
  expect(html).not.toContain("hiddenContent");
  expect(html).toContain("隐藏文字未显示");
  expect(html).toContain(S.draftOnly);
  expect(html).toMatch(/type="checkbox"[^>]*>/);
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(html).toMatch(/disabled=""[^>]*>只加入已读取文字/);
});

it("discloses saved-cell scope independently of preview, preserves the whole tail, and never preselects omission consent", () => {
  const text = `${"cell ".repeat(4000)}<script>last-cell-complete</script>`;
  const html = renderToStaticMarkup(
    <DocumentInputReview
      name="table.xlsx"
      result={{
        text,
        actualTextChars: text.length,
        local: {
          schema: 1,
          format: "xlsx",
          source: {
            root: "/d",
            path: "/d/table.xlsx",
            resolvedPath: "/d/table.xlsx",
            name: "table.xlsx",
            size: 100,
            sha256: "a".repeat(64),
            version: "v",
          },
          textSha256: "b".repeat(64),
          utf8Bytes: new TextEncoder().encode(text).byteLength,
          selection: "read-saved-cell-content",
          scope: { mode: "all-saved-cells", sheetIds: ["s1", "s2"] },
          partial: true,
          partialSelected: false,
          warnings: [
            { code: "images", count: 2 },
            { code: "externalContent", count: 1 },
          ],
        },
      }}
      xlsxRequest={{ mode: "all-saved-cells" }}
      onXlsxRequest={() => {}}
      partialSelected={false}
      onPartialSelected={() => {}}
      busy={null}
      error={null}
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain(S.xlsxAllDetails);
  expect(html).toContain(S.xlsxSheetCount(2));
  expect(html).toContain("&lt;script&gt;last-cell-complete&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("2 份保存的相关内容");
  expect(html).toContain("已检测到");
  expect(html).not.toContain("2 处图片");
  expect(html).not.toContain("externalContent");
  expect(html).toMatch(/type="radio"[^>]*checked/);
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(html).toMatch(/disabled=""[^>]*>只加入已读取文字/);
});

it("keeps empty visible scope recoverable only through an explicit range choice", () => {
  const html = renderToStaticMarkup(
    <DocumentInputReview
      name="hidden.xlsx"
      result={null}
      xlsxRequest={{ mode: "visible-saved-cells" }}
      onXlsxRequest={() => {}}
      partialSelected={false}
      onPartialSelected={() => {}}
      busy={null}
      error={S.xlsxScopeEmpty}
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain(S.xlsxScopeEmpty);
  expect(html).toContain(S.xlsxAll);
  expect(html.match(/type="radio"[^>]*checked/g)).toHaveLength(1);
  expect(html).toMatch(/disabled=""[^>]*>加入这些文字/);
  expect(html).not.toContain("<textarea");
});
