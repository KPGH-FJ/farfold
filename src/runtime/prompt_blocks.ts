import type { DraftAttachment } from "./drafts";
import type { Attachment, PromptBlock, ThreadItem } from "./session_types";
import {
  parseApprovedDocumentText,
  type ApprovedDocumentText,
} from "./document_input_types";
import { normalizeMessageAttachments } from "./message_attachments";
import { DOCUMENT_INPUT_STRINGS as S } from "./document_input_strings";
import type { PromptAdmission } from "./queue";
import { documentMediaFormat } from "./document_media_type";
import { COMPOSER_CONTROLS as C } from "./composer_strings";

export function promptText(
  blocks: readonly PromptBlock[],
  separator = "\n",
): string {
  return blocks
    .filter(
      (block): block is Extract<PromptBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join(separator);
}
export function titleFromBlocks(blocks: readonly PromptBlock[]): string {
  return promptText(blocks, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}
export function promptRejectionNotice(result: PromptAdmission): string | null {
  if (result.status !== "rejected") return null;
  if (result.reason === "permission_scope_unverified")
    return C.permissionScopeUnverified;
  return result.reason === "embedded_context_unsupported"
    ? S.capabilityUnsupported
    : result.reason === "embedded_context_unknown"
      ? S.capabilityUnknown
      : null;
}
export function promptRejectionItem(
  result: PromptAdmission,
  nextId: () => string,
): Extract<ThreadItem, { kind: "notice" }> | null {
  const message = promptRejectionNotice(result);
  return message
    ? { kind: "notice", id: nextId(), message, time: Date.now() }
    : null;
}

/** Recognizing an old document text resource only withholds authority. It never
 * invents a verified file or authorizes reading or sending it. */
function historicalDocumentUri(uri: string): boolean {
  try {
    const value = new URL(uri);
    return /\.(docx|xlsx|pdf)$/i.test(decodeURIComponent(value.pathname));
  } catch {
    return /\.(docx|xlsx|pdf)$/i.test(uri);
  }
}

export function resourceDocumentText(
  block: Extract<PromptBlock, { type: "resource" }>,
): ApprovedDocumentText | undefined {
  if (block.localDocumentText !== undefined)
    return parseApprovedDocumentText({
      text: block.resource.text,
      local: block.localDocumentText,
    });
  if (
    historicalDocumentUri(block.resource.uri) ||
    documentMediaFormat(block.resource.mimeType) !== undefined
  )
    return parseApprovedDocumentText({
      text: block.resource.text,
      local: null,
    });
  return undefined;
}

/** Shared input reconstruction for queue editing, resending and unknown input.
 * Ordinary resources retain their existing content-refresh behavior. */
export function resourceDraftAttachment(
  block: Extract<PromptBlock, { type: "resource" | "resource_link" }>,
  options: { name?: string; recovered?: boolean; keepContent?: boolean } = {},
): DraftAttachment {
  const uri = block.type === "resource" ? block.resource.uri : block.uri;
  const documentText =
    block.type === "resource" ? resourceDocumentText(block) : undefined;
  return {
    id: crypto.randomUUID(),
    kind: "file",
    name:
      options.name ??
      (block.type === "resource_link"
        ? block.name
        : uri.split("/").pop() || uri),
    uri,
    mimeType:
      block.type === "resource" ? block.resource.mimeType : block.mimeType,
    ...(documentText
      ? {
          documentText: structuredClone(documentText),
          recovered: options.recovered === true || documentText.local === null,
        }
      : { recovered: options.recovered }),
    ...(options.keepContent && block.type === "resource"
      ? { content: block.resource.text }
      : {}),
  };
}

/** Enumerate official fields immediately before IPC. Local source metadata
 * remains in the unsent queue but can never reach the Agent. */
export function wirePromptBlocks(
  blocks: readonly PromptBlock[],
): PromptBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return {
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
          ...(block.uri ? { uri: block.uri } : {}),
        };
      case "resource_link":
        return {
          type: "resource_link",
          name: block.name,
          uri: block.uri,
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        };
      case "resource":
        return {
          type: "resource",
          resource: {
            uri: block.resource.uri,
            mimeType: block.resource.mimeType,
            text: block.resource.text,
          },
        };
      default:
        throw new Error(S.failed);
    }
  });
}

/** Official notifications cannot supply this local authority. Preserve it only
 * for the outgoing input that passed the dispatch checks. */
export function localMessageAttachments(
  blocks: readonly PromptBlock[],
): Attachment[] {
  const out: Attachment[] = [];
  for (const block of blocks) {
    const [attachment] = normalizeMessageAttachments([block]);
    if (!attachment) continue;
    if (block.type === "resource") {
      const documentText = resourceDocumentText(block);
      if (documentText)
        attachment.localDocumentText = structuredClone(documentText.local);
    }
    out.push(attachment);
  }
  return out;
}
