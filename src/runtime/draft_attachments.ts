import { audioSourceError } from "./audio_source_error";
import {
  audioNameCandidate,
  AudioInputError,
  addAudioBytes,
  verifyAudioInput,
} from "./audio_input";
import { invoke } from "@tauri-apps/api/core";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";
import { DRAFT_STRINGS } from "./draft_storage";
import { verifyDocumentInput } from "./document_input";
import { DocumentInputError } from "./document_input_types";
import { documentSourceError } from "./document_source_error";
import { resourceDocumentText } from "./prompt_blocks";
import { localResourcePath } from "./file_delivery";
import { documentMediaFormat } from "./document_media_type";
import { FILE_DELIVERY_STRINGS } from "./file_delivery_strings";
import {
  IMAGE_INPUT_STRINGS,
  isBitmapMime,
  readFileImage,
  validateDraftImage,
} from "./draft_images";

type AttachmentCheckCode =
  | "unsupportedText"
  | "tooLarge"
  | "notFile"
  | "invalidLocation"
  | "unreadable"
  | "checkPending"
  | "checkBusy";

/** Transient, safe input feedback only; never store a native error or path. */
export class DraftAttachmentCheckError extends Error {
  constructor(
    readonly code: AttachmentCheckCode,
    message: string,
  ) {
    super(message);
  }
}

function checkFailure(
  reason: unknown,
  uri: string,
  attachment?: { name?: string; mimeType?: string },
): DraftAttachmentCheckError {
  const value = reason as { code?: unknown } | null;
  const code =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "code")
      ? value.code
      : null;
  // This is only a conservative hint to an existing visible action. MIME alone
  // enables that action for PDF; the other current readers use the name/path.
  // It grants no permission, parses no document, and never changes the payload.
  const reviewAvailable =
    /\.(docx|xlsx|pdf)$/i.test(attachment?.name ?? "") ||
    /\.(docx|xlsx|pdf)$/i.test(localResourcePath(uri) ?? "") ||
    documentMediaFormat(attachment?.mimeType) === "pdf";
  switch (code) {
    case "unsupportedText":
      return new DraftAttachmentCheckError(
        code,
        reviewAvailable
          ? DRAFT_STRINGS.attachmentUnsupportedReview
          : DRAFT_STRINGS.attachmentUnsupportedText,
      );
    case "tooLarge":
      return new DraftAttachmentCheckError(
        code,
        reviewAvailable
          ? DRAFT_STRINGS.attachmentTooLargeReview
          : DRAFT_STRINGS.attachmentTooLarge,
      );
    case "notFile":
      return new DraftAttachmentCheckError(
        code,
        DRAFT_STRINGS.attachmentNotFile,
      );
    case "invalidLocation":
      return new DraftAttachmentCheckError(
        code,
        DRAFT_STRINGS.attachmentInvalidLocation,
      );
    case "checkPending":
      return new DraftAttachmentCheckError(
        code,
        FILE_DELIVERY_STRINGS.checkWaitExpired,
      );
    case "checkBusy":
      return new DraftAttachmentCheckError(
        code,
        FILE_DELIVERY_STRINGS.checkBusy,
      );
    default:
      return new DraftAttachmentCheckError(
        "unreadable",
        DRAFT_STRINGS.attachmentFailed,
      );
  }
}

async function checkFile(
  uri: string,
  embed: boolean,
  attachment?: { name?: string; mimeType?: string },
): Promise<string | null> {
  try {
    return await invoke<string | null>("draft_attachment_check", {
      uri,
      embed,
    });
  } catch (error) {
    throw checkFailure(error, uri, attachment);
  }
}

/** Capability admits an explicit text choice; it never chooses a delivery
 * mode. Unmarked drafts retain the previous behavior without guessing origin. */
function checkFileDeliveryMode(attachment: DraftAttachment): void {
  if (
    attachment.deliveryMode !== undefined &&
    attachment.deliveryMode !== "location" &&
    attachment.deliveryMode !== "text"
  )
    throw new Error(DRAFT_STRINGS.attachmentFailed);
}

function readsFileText(attachment: DraftAttachment, embed: boolean): boolean {
  if (attachment.deliveryMode === "text") {
    if (!embed) throw new DocumentInputError("capabilityUnsupported");
    return true;
  }
  if (attachment.deliveryMode === "location") return false;
  return (
    embed &&
    !isBitmapMime(attachment.mimeType) &&
    !audioNameCandidate(attachment.name, attachment.mimeType)
  );
}

/** Check explicit user attachments at dispatch, including those restored after
 * restart. Never send cached file contents from before the restart. */
export async function validateQueuedAttachments(
  blocks: PromptBlock[],
  options: { reparseDocuments?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const updates: (() => void)[] = [];
  let audioBytes = 0;
  for (const block of blocks) {
    if (block.type === "audio") {
      const capture = await verifyAudioInput(block);
      audioBytes = addAudioBytes(audioBytes, capture.file.size);
      continue;
    }
    if (block.type === "resource_link" && block.uri.startsWith("file:"))
      await checkFile(block.uri, false, block);
    if (block.type === "resource") {
      const documentText = resourceDocumentText(block);
      if (documentText) {
        await verifyDocumentInput(documentText, block.resource.uri, {
          reparse: options.reparseDocuments === true,
          signal: options.signal,
        });
      } else if (block.resource.uri.startsWith("file:")) {
        const resource = block.resource;
        const content = await checkFile(resource.uri, true, resource);
        if (content !== null)
          updates.push(() => {
            resource.text = content;
          });
      }
    }
    if (block.type === "image") {
      const image = block.uri
        ? await readFileImage(block.uri)
        : await validateDraftImage(block.data, block.mimeType);
      updates.push(() => {
        block.data = image.data;
        block.mimeType = image.mimeType;
      });
    }
  }
  // The live queue can be saved even when a later attachment check fails.
  for (const update of updates) update();
}

export async function prepareDraftAttachments(
  attachments: DraftAttachment[],
  embed: boolean,
  options: { reparseDocuments?: boolean; signal?: AbortSignal } = {},
) {
  const prepared: DraftAttachment[] = [];
  let audioBytes = 0;
  // Native checks have a shared limit on genuinely unfinished OS work. Read
  // this one message in order rather than filling every slot at once.
  for (const attachment of attachments) {
    if (attachment.audioClassificationFailed)
      throw new AudioInputError("classificationFailed");
    if (attachment.imageClassificationFailed)
      throw new Error(IMAGE_INPUT_STRINGS.classificationFailed);
    if (attachment.kind === "audio") {
      try {
        if (!attachment.localAudio)
          throw new AudioInputError(
            attachment.data ? "sourceUnknown" : "approvalRequired",
          );
        if (attachment.recovered && !options.reparseDocuments)
          throw new AudioInputError("recoveryRequired");
        const capture = await verifyAudioInput(attachment);
        audioBytes = addAudioBytes(audioBytes, capture.file.size);
        prepared.push({ ...attachment, recovered: false, loading: false });
      } catch (error) {
        throw audioSourceError(error, attachment);
      }
      continue;
    }
    if (attachment.kind === "image") {
      const image = attachment.uri
        ? await readFileImage(attachment.uri)
        : await validateDraftImage(attachment.data ?? "", attachment.mimeType);
      prepared.push({
        ...attachment,
        ...image,
        imageChecked: { ...image, uri: attachment.uri },
        recovered: false,
        loading: false,
      });
      continue;
    }
    if (!attachment.uri) throw new Error(DRAFT_STRINGS.attachmentFailed);
    checkFileDeliveryMode(attachment);
    if (attachment.documentText !== undefined) {
      try {
        if (!embed) throw new DocumentInputError("capabilityUnsupported");
        if (attachment.recovered && !options.reparseDocuments)
          throw new DocumentInputError("recoveryRequired");
        await verifyDocumentInput(attachment.documentText, attachment.uri, {
          reparse: options.reparseDocuments === true,
          signal: options.signal,
        });
      } catch (error) {
        throw documentSourceError(error, attachment);
      }
      prepared.push({ ...attachment, recovered: false, loading: false });
      continue;
    }
    const readText = readsFileText(attachment, embed);
    const content = await checkFile(attachment.uri, readText, attachment);
    if (attachment.deliveryMode === "text" && typeof content !== "string")
      throw new Error(DRAFT_STRINGS.attachmentFailed);
    prepared.push({
      ...attachment,
      content: readText ? (content ?? undefined) : undefined,
      recovered: false,
      loading: false,
    });
  }
  return prepared;
}

/** Only prepared data reaches ACP. File-backed image URI also remains on the
 * official image block so queue editing and dispatch can recheck that source. */
export function attachmentPromptBlocks(
  text: string,
  attachments: DraftAttachment[],
  embed: boolean,
): PromptBlock[] {
  const out: PromptBlock[] = [];
  if (text.trim()) out.push({ type: "text", text: text.trim() });
  let audioBytes = 0;
  for (const attachment of attachments) {
    if (attachment.audioClassificationFailed)
      throw new AudioInputError("classificationFailed");
    if (attachment.imageClassificationFailed)
      throw new Error(IMAGE_INPUT_STRINGS.classificationFailed);
    if (attachment.kind === "audio") {
      if (
        !attachment.localAudio ||
        !attachment.data ||
        attachment.mimeType !== "audio/wav"
      )
        throw new AudioInputError("sourceUnknown");
      audioBytes = addAudioBytes(audioBytes, attachment.localAudio.file.size);
      out.push({
        type: "audio",
        data: attachment.data,
        mimeType: attachment.mimeType,
        uri: attachment.uri,
        localAudio: structuredClone(attachment.localAudio),
      });
    } else if (attachment.kind === "image" && attachment.data) {
      out.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType ?? "image/png",
        ...(attachment.uri ? { uri: attachment.uri } : {}),
      });
    } else if (attachment.kind === "file" && attachment.uri) {
      checkFileDeliveryMode(attachment);
      if (attachment.documentText !== undefined) {
        if (!embed) throw new DocumentInputError("capabilityUnsupported");
        if (!attachment.documentText.local)
          throw new DocumentInputError("sourceUnknown");
        out.push({
          type: "resource",
          resource: {
            uri: attachment.uri,
            mimeType: "text/plain",
            text: attachment.documentText.text,
          },
          localDocumentText: structuredClone(attachment.documentText.local),
        });
      } else {
        const readText = readsFileText(attachment, embed);
        if (
          attachment.deliveryMode === "text" &&
          attachment.content === undefined
        )
          throw new Error(DRAFT_STRINGS.attachmentFailed);
        if (readText && attachment.content !== undefined)
          out.push({
            type: "resource",
            resource: {
              uri: attachment.uri,
              mimeType: "text/plain",
              text: attachment.content,
            },
          });
        else
          out.push({
            type: "resource_link",
            name: attachment.name,
            uri: attachment.uri,
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          });
      }
    }
  }
  return out;
}
