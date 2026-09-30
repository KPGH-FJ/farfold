import {
  composerDrafts,
  type ComposerDraft,
  type DraftAttachment,
} from "./drafts";
import type { PromptBlock } from "./session_types";
import { queuedAttachmentsNeedReview } from "./recovered_attachments";

const liveTargets = new WeakMap<
  NonNullable<ComposerDraft["queueEdit"]>,
  PromptBlock[]
>();

export function queueEditorKey(threadKey: string) {
  return `queue-edit:${threadKey}`;
}
export function startQueueEditor(
  threadKey: string,
  index: number,
  blocks: PromptBlock[],
) {
  const attachments: DraftAttachment[] = [];
  const text: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "image")
      attachments.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: `image.${block.mimeType.split("/")[1] ?? "png"}`,
        data: block.data,
        mimeType: block.mimeType,
        recovered: queuedAttachmentsNeedReview(blocks),
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
        recovered: queuedAttachmentsNeedReview(blocks),
      });
    }
  }
  const editing = { index, original: structuredClone(blocks) };
  liveTargets.set(editing, blocks);
  composerDrafts.update(queueEditorKey(threadKey), () => ({
    text: text.join("\n"),
    attachments,
    queueEdit: editing,
  }));
}

/** Content equality cannot identify duplicate messages. A cold edit keeps its
 * text but requires a fresh target selection instead of guessing ownership. */
export function queueEditorTarget(
  draft: ComposerDraft,
  queued: PromptBlock[][],
) {
  const target = draft.queueEdit && liveTargets.get(draft.queueEdit);
  return target &&
    queued.includes(target) &&
    JSON.stringify(target) === JSON.stringify(draft.queueEdit?.original)
    ? target
    : null;
}

export function keepQueueEditAsDraft(threadKey: string) {
  const key = queueEditorKey(threadKey);
  const editing = composerDrafts.read(key);
  composerDrafts.update(`session:${threadKey}`, (draft) => ({
    ...draft,
    text: [draft.text, editing.text].filter(Boolean).join("\n\n"),
    attachments: [...draft.attachments, ...editing.attachments],
  }));
  composerDrafts.clear(key);
}
