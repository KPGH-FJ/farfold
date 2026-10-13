import type { LocalDocumentText } from "./document_input_types";
import {
  DOCUMENT_INPUT_STRINGS as S,
  XLSX_INPUT_WARNING_TEXT,
} from "./document_input_strings";
import { DOCUMENT_WARNINGS } from "./document_strings";
import { PDF_INPUT_SCOPE_TEXT } from "./pdf_input_text";
import {
  XLSX_INPUT_WARNING_UNITS,
  type XlsxInputScopeMode,
  type XlsxInputWarning,
} from "./xlsx_input_types";

export function xlsxInputWarningCount(warning: XlsxInputWarning): string {
  const count = warning.count.toLocaleString();
  switch (XLSX_INPUT_WARNING_UNITS[warning.code]) {
    case "cells":
      return `${count} 个保存的单元格`;
    case "formulas":
      return `${count} 个保存公式的单元格`;
    case "categories":
      return `${count} 类`;
    case "elements":
      return `${count} 个记录项`;
    case "parts":
      return `${count} 份保存的相关内容`;
    case "presence":
      return "已检测到";
  }
}

export interface DocumentInputPresentation {
  scope: string;
  count: string;
  sheetCount?: string;
  pageCount?: string;
  warnings: {
    code: string;
    text: string;
    count: number;
    countText: string;
  }[];
  xlsxScopeMode?: XlsxInputScopeMode;
  pdfScope?: boolean;
}

/** Render the confirmed format and scope, independently of preview settings. */
export function documentInputPresentation(
  local: LocalDocumentText,
): DocumentInputPresentation {
  if (local.format === "docx")
    return {
      scope: S.scope,
      count: S.count(local.utf8Bytes, local.imageReferences),
      warnings: local.warnings.map((warning) => ({
        ...warning,
        text: DOCUMENT_WARNINGS[warning.code],
        countText: String(warning.count),
      })),
    };
  if (local.format === "pdf")
    return {
      scope: S.pdfDecodedText,
      count: S.pdfCount(local.utf8Bytes),
      pageCount: S.pdfPageCount(local.scope.pageCount),
      pdfScope: true,
      warnings: local.warnings.map((warning) => ({
        ...warning,
        text:
          warning.code === "pagesWithoutText"
            ? S.pdfPagesWithoutText
            : PDF_INPUT_SCOPE_TEXT[warning.code],
        countText:
          warning.unit === "pages"
            ? `${warning.count.toLocaleString()} 页`
            : "范围限制",
      })),
    };
  return {
    scope:
      local.scope.mode === "all-saved-cells"
        ? S.xlsxAllDetails
        : S.xlsxVisibleDetails,
    count: S.xlsxCount(local.utf8Bytes),
    sheetCount: S.xlsxSheetCount(local.scope.sheetIds.length),
    xlsxScopeMode: local.scope.mode,
    warnings: local.warnings.map((warning) => ({
      ...warning,
      text: XLSX_INPUT_WARNING_TEXT[warning.code],
      countText: xlsxInputWarningCount(warning),
    })),
  };
}
