import type { ComposerDraft, DraftAttachment } from "./drafts";
import type { PromptBlock } from "./session_types";

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
      const uri = block.type === "resource" ? block.resource.uri : block.uri;
      attachments.push({
        id: crypto.randomUUID(),
        kind: "file",
        name:
          block.type === "resource_link"
            ? block.name
            : (uri.split("/").pop() ?? uri),
        uri,
        mimeType:
          block.type === "resource" ? block.resource.mimeType : block.mimeType,
        content: block.type === "resource" ? block.resource.text : undefined,
        recovered: true,
      });
    }
  }
  return {
    ...draft,
    text: [draft.text, text.join("\n")].filter(Boolean).join("\n\n"),
    attachments: [...draft.attachments, ...attachments],
  };
}
