import { invoke } from "@tauri-apps/api/core";
import type { DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";
import { DRAFT_STRINGS } from "./draft_storage";

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
): Promise<void> {
  for (const block of blocks) {
    if (block.type === "resource_link" && block.uri.startsWith("file:"))
      await checkFile(block.uri, false);
    if (block.type === "resource" && block.resource.uri.startsWith("file:")) {
      const content = await checkFile(block.resource.uri, true);
      if (content !== null) block.resource.text = content;
    }
    if (block.type === "image" && !block.data)
      throw new Error(DRAFT_STRINGS.attachmentIncomplete);
  }
}

export async function prepareDraftAttachments(
  attachments: DraftAttachment[],
  embed: boolean,
) {
  const prepared: DraftAttachment[] = [];
  // Native checks have a shared limit on genuinely unfinished OS work. Read
  // this one message in order rather than filling every slot at once.
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      if (!attachment.data) throw new Error(DRAFT_STRINGS.attachmentIncomplete);
      prepared.push(attachment);
      continue;
    }
    if (!attachment.uri) throw new Error(DRAFT_STRINGS.attachmentFailed);
    const content = await checkFile(attachment.uri, embed);
    prepared.push({
      ...attachment,
      content: content ?? undefined,
      recovered: false,
      loading: false,
    });
  }
  return prepared;
}
