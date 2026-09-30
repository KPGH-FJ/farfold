import type { PromptBlock } from "./session_types";

// Only live identities of restored unsent input; no additional persisted state.
const restored = new WeakSet<PromptBlock[]>();

export function markRestoredQueueAttachments(queue: PromptBlock[][]) {
  for (const blocks of queue)
    if (blocks.some((block) => block.type !== "text")) restored.add(blocks);
}

export function queuedAttachmentsNeedReview(blocks: PromptBlock[]) {
  return restored.has(blocks);
}

export function forgetRestoredQueueAttachments(blocks: PromptBlock[]) {
  restored.delete(blocks);
}
