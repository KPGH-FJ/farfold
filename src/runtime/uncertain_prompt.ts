import type { ComposerDraft, DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";
import { resourceDraftAttachment } from "./prompt_blocks";

/** Preserve the submitted input as editable user-owned input, not a retry.
 * This conversion never reads a file, calls an Agent, or replaces later typing. */
export function keepPromptAsDraft(
  draft: ComposerDraft,
  blocks: readonly PromptBlock[],
): ComposerDraft {
  const text: string[] = [];
  const attachments: DraftAttachment[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image")
      attachments.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: `image.${block.mimeType.split("/")[1] ?? "png"}`,
        data: block.data,
        mimeType: block.mimeType,
        uri: block.uri,
        recovered: true,
      });
    else {
      attachments.push(
        resourceDraftAttachment(block, { recovered: true, keepContent: true }),
      );
    }
  }
  return {
    ...draft,
    text: [draft.text, text.join("\n")].filter(Boolean).join("\n\n"),
    attachments: [...draft.attachments, ...attachments],
  };
}
