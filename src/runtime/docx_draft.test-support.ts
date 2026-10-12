import { createHash } from "node:crypto";
import type { ApprovedDocumentText } from "./document_input_types";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";

export const DOCX_URI = "file:///owned/report.docx";
export function approvedDocument(
  text = "正文首\n最后单元格 TAIL-9817\n页脚 FOOT-3129",
): ApprovedDocumentText {
  return {
    text,
    local: {
      schema: 1,
      format: "docx",
      source: {
        root: "/owned",
        path: "/owned/report.docx",
        resolvedPath: "/owned/report.docx",
        name: "report.docx",
        size: 1234,
        sha256: "1".repeat(64),
        version: "fixture-version",
      },
      textSha256: createHash("sha256").update(text).digest("hex"),
      utf8Bytes: new TextEncoder().encode(text).byteLength,
      selection: "read-visible-text",
      partial: false,
      partialSelected: false,
      warnings: [{ code: "continuousLayout", count: 1 }],
      imageReferences: 0,
    },
  };
}
export function documentAttachment(recovered = false): DraftAttachment {
  return {
    id: "owned-docx",
    kind: "file",
    name: "report.docx",
    uri: DOCX_URI,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    documentText: approvedDocument(),
    recovered,
  };
}
export function documentBlock(): Extract<PromptBlock, { type: "resource" }> {
  const approved = approvedDocument();
  return {
    type: "resource",
    resource: { uri: DOCX_URI, mimeType: "text/plain", text: approved.text },
    localDocumentText: approved.local,
  };
}
