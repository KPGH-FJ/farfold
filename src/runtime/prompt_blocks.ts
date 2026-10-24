import { localResourcePath } from "./file_delivery";
import { AUDIO_INPUT, parseLocalAudio } from "./audio_input";
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
import { PROMPT_ADMISSION as P } from "./prompt_admission_strings";

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
  switch (result.reason) {
    case "send_wait_limit":
      return P.full;
    case "send_wait_payload":
      return P.payload;
    case "send_wait_cancelled":
      return P.cancelled;
    case "send_wait_timeout":
      return P.timeout;
  }
  const audioReasons = {
    audio_unknown: AUDIO_INPUT.capabilityUnknown,
    audio_unsupported: AUDIO_INPUT.capabilityUnsupported,
    audio_limit: AUDIO_INPUT.limit,
    audio_invalid: AUDIO_INPUT.invalid,
    audio_format_unsupported: AUDIO_INPUT.unsupported,
    audio_duration_limit: AUDIO_INPUT.durationLimit,
  };
  if (result.reason && Object.hasOwn(audioReasons, result.reason))
    return audioReasons[result.reason as keyof typeof audioReasons];
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
    deliveryMode: block.type === "resource" ? "text" : "location",
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

/** Enumerate official fields immediately before IPC. Reviewed document bodies
 * use baseline Text: a resource URI can make a consumer reread the unreviewed
 * original instead. A separate filename label keeps sources distinguishable;
 * paths/version metadata stays in the queue and local message. */
export function wirePromptBlocks(
  blocks: readonly PromptBlock[],
): PromptBlock[] {
  return blocks.flatMap<PromptBlock>((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "audio":
        return { type: "audio", data: block.data, mimeType: block.mimeType };
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
        if (block.localDocumentText !== undefined) {
          const approved = resourceDocumentText(block);
          if (!approved?.local) throw new Error(S.failed);
          return [
            {
              type: "text",
              text: JSON.stringify({ fileName: approved.local.source.name }),
            },
            { type: "text", text: approved.text },
          ];
        }
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
    if (block.type === "audio")
      attachment.localAudio = structuredClone(block.localAudio ?? null);
    if (block.type === "resource") {
      const documentText = resourceDocumentText(block);
      if (documentText)
        attachment.localDocumentText = structuredClone(documentText.local);
    }
    out.push(attachment);
  }
  return out;
}

export function audioDraftAttachment(
  block: Extract<PromptBlock, { type: "audio" }>,
  options: { name?: string; recovered?: boolean } = {},
): DraftAttachment {
  let local = null;
  try {
    local = parseLocalAudio(block.localAudio);
    if (!block.uri || localResourcePath(block.uri) !== local?.file.path)
      local = null;
  } catch {
    /* Retain bytes without granting an invalid source. */
  }
  return {
    id: crypto.randomUUID(),
    kind: "audio",
    name: options.name ?? local?.file.name ?? AUDIO_INPUT.title,
    data: block.data,
    mimeType: block.mimeType,
    uri: local ? block.uri : undefined,
    localAudio: local,
    recovered: options.recovered === true || !local,
  };
}
