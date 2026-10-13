import { createHash } from "node:crypto";
import type { ApprovedDocumentText } from "./document_input_types";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";

export const XLSX_URI = "file:///owned/report.xlsx";
export function approvedWorkbook(
  text = "SAVED_ALL_ROWS\nHIDDEN_SOURCE_TAIL_6841",
): ApprovedDocumentText {
  return {
    text,
    local: {
      schema: 1,
      format: "xlsx",
      selection: "read-saved-cell-content",
      source: {
        root: "/owned",
        path: "/owned/report.xlsx",
        resolvedPath: "/owned/report.xlsx",
        name: "report.xlsx",
        size: 2000,
        sha256: "1".repeat(64),
        version: "workbook-version",
      },
      textSha256: createHash("sha256").update(text).digest("hex"),
      utf8Bytes: Buffer.byteLength(text),
      partial: false,
      partialSelected: false,
      scope: { mode: "all-saved-cells", sheetIds: ["rId8", "hidden-rId2"] },
      warnings: [],
    },
  };
}
export function workbookAttachment(recovered = false): DraftAttachment {
  return {
    id: "owned-xlsx",
    kind: "file",
    name: "report.xlsx",
    uri: XLSX_URI,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    documentText: approvedWorkbook(),
    recovered,
  };
}
export function workbookBlock(): Extract<PromptBlock, { type: "resource" }> {
  const approved = approvedWorkbook();
  return {
    type: "resource",
    resource: { uri: XLSX_URI, mimeType: "text/plain", text: approved.text },
    localDocumentText: approved.local,
  };
}
