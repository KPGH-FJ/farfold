import { invoke } from "@tauri-apps/api/core";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";
import { DRAFT_STRINGS } from "./draft_storage";
import { verifyDocumentInput } from "./document_input";
import { DocumentInputError } from "./document_input_types";
import { resourceDocumentText } from "./prompt_blocks";
import {
  isBitmapMime,
  readFileImage,
  validateDraftImage,
} from "./draft_images";

async function checkFile(uri: string, embed: boolean): Promise<string | null> {
  try {
    return await invoke<string | null>("draft_attachment_check", {
      uri,
      embed,
    });
  } catch {
    throw new Error(DRAFT_STRINGS.attachmentFailed);
  }
}

/** Check explicit user attachments at dispatch, including those restored after
 * restart. Never send cached file contents from before the restart. */
export async function validateQueuedAttachments(
  blocks: PromptBlock[],
  options: { reparseDocuments?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  for (const block of blocks) {
    if (block.type === "resource_link" && block.uri.startsWith("file:"))
      await checkFile(block.uri, false);
    if (block.type === "resource") {
      const documentText = resourceDocumentText(block);
      if (documentText) {
        await verifyDocumentInput(documentText, block.resource.uri, {
          reparse: options.reparseDocuments === true,
          signal: options.signal,
        });
      } else if (block.resource.uri.startsWith("file:")) {
        const content = await checkFile(block.resource.uri, true);
        if (content !== null) block.resource.text = content;
      }
    }
    if (block.type === "image") {
      const image = block.uri
        ? await readFileImage(block.uri)
        : await validateDraftImage(block.data, block.mimeType);
      block.data = image.data;
      block.mimeType = image.mimeType;
    }
  }
}

export async function prepareDraftAttachments(
  attachments: DraftAttachment[],
  embed: boolean,
  options: { reparseDocuments?: boolean; signal?: AbortSignal } = {},
) {
  const prepared: DraftAttachment[] = [];
  // Native checks have a shared limit on genuinely unfinished OS work. Read
  // this one message in order rather than filling every slot at once.
  for (const attachment of attachments) {
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
    if (attachment.documentText !== undefined) {
      if (!embed) throw new DocumentInputError("capabilityUnsupported");
      if (attachment.recovered && !options.reparseDocuments)
        throw new DocumentInputError("recoveryRequired");
      await verifyDocumentInput(attachment.documentText, attachment.uri, {
        reparse: options.reparseDocuments === true,
        signal: options.signal,
      });
      prepared.push({ ...attachment, recovered: false, loading: false });
      continue;
    }
    const content = await checkFile(
      attachment.uri,
      embed && !isBitmapMime(attachment.mimeType),
    );
    prepared.push({
      ...attachment,
      content: content ?? undefined,
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
  for (const attachment of attachments) {
    if (attachment.kind === "image" && attachment.data) {
      out.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType ?? "image/png",
        ...(attachment.uri ? { uri: attachment.uri } : {}),
      });
    } else if (attachment.kind === "file" && attachment.uri) {
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
      } else if (
        embed &&
        !isBitmapMime(attachment.mimeType) &&
        attachment.content !== undefined
      )
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
  return out;
}
