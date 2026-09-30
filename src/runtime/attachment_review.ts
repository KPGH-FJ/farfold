import {
  composerDrafts,
  draftPersistence,
  type ComposerDraft,
  type DraftAttachment,
} from "./drafts";
import {
  prepareDraftAttachments,
  validateQueuedAttachments,
} from "./draft_attachments";
import { threads } from "./sessions";
import type { PromptBlock, ThreadState } from "./session_types";
import { ATTACHMENT_REVIEW as S } from "./attachment_review_strings";
import {
  forgetRestoredQueueAttachments,
  queuedAttachmentsNeedReview,
} from "./recovered_attachments";

export interface AttachmentReviewEntry {
  id: string;
  label: string;
  group: string;
  locked?: string;
}
export interface AttachmentReview {
  draftKey: string;
  draft: ComposerDraft;
  generation: number;
  thread: ThreadState | null;
  queue: PromptBlock[][];
  queueContents: string[];
  entries: AttachmentReviewEntry[];
}
const draftId = (index: number) => `draft:${index}`;
const queueId = (index: number, block: number) => `queue:${index}:${block}`;
const draftLocked = (draft: ComposerDraft) =>
  draft.sendPending || draft.pendingConversation ? S.protected : undefined;
function queueLocked(
  thread: ThreadState,
  blocks: PromptBlock[],
  index: number,
) {
  if (thread.uncertainPrompt === blocks || (thread.submitting && index === 0))
    return S.protected;
  if (composerDrafts.read(`queue-edit:${thread.key}`).queueEdit)
    return S.editing;
  return undefined;
}
function blockLabel(block: PromptBlock) {
  if (block.type === "image") return S.image;
  if (block.type === "resource_link") return block.name;
  if (block.type === "resource")
    return block.resource.uri.split("/").pop() || block.resource.uri;
  return "";
}

export function attachmentReviewEntries(
  draft: ComposerDraft,
  thread: ThreadState | null,
): AttachmentReviewEntry[] {
  const entries: AttachmentReviewEntry[] = draft.attachments.flatMap(
    (item, index) =>
      item.recovered
        ? [
            {
              id: draftId(index),
              label: item.name,
              group: S.draft,
              locked: draftLocked(draft),
            },
          ]
        : [],
  );
  thread?.queued.forEach((blocks, index) => {
    if (!thread || !queuedAttachmentsNeedReview(blocks)) return;
    blocks.forEach((block, blockIndex) => {
      if (block.type !== "text")
        entries.push({
          id: queueId(index, blockIndex),
          label: blockLabel(block),
          group: S.queue(index),
          locked: queueLocked(thread, blocks, index),
        });
    });
  });
  return entries;
}

export function captureAttachmentReview(
  draftKey: string,
  thread: ThreadState | null,
): AttachmentReview {
  const draft = composerDrafts.read(draftKey);
  const queue = [...(thread?.queued ?? [])];
  return {
    draftKey,
    draft,
    generation: composerDrafts.generation(draftKey),
    thread,
    queue,
    queueContents: queue.map((blocks) => JSON.stringify(blocks)),
    entries: attachmentReviewEntries(draft, thread),
  };
}

function assertCurrent(review: AttachmentReview) {
  if (
    draftPersistence.snapshot().interactionLocked ||
    composerDrafts.read(review.draftKey) !== review.draft ||
    composerDrafts.generation(review.draftKey) !== review.generation
  )
    throw new Error(S.changed);
  const state = review.thread;
  if (
    state &&
    (threads.thread(state.key) !== state ||
      state.queued.length !== review.queue.length ||
      review.queue.some(
        (blocks, index) =>
          state.queued[index] !== blocks ||
          JSON.stringify(blocks) !== review.queueContents[index],
      ))
  )
    throw new Error(S.changed);
  for (const entry of review.entries) {
    if (entry.locked) continue;
    const [kind, index] = entry.id.split(":");
    if (
      kind === "draft"
        ? draftLocked(review.draft)
        : !state ||
          queueLocked(state, review.queue[Number(index)], Number(index))
    )
      throw new Error(S.changed);
  }
}

/** Validate independent copies first. Apply only to the exact still-owned input,
 * synchronously, after every check succeeds; never invoke send/continueQueue. */
export async function confirmAttachmentReview(
  review: AttachmentReview,
  kept: ReadonlySet<string>,
  embed: boolean,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  assertCurrent(review);
  const editable = new Map(
    review.entries
      .filter((item) => !item.locked)
      .map((item) => [item.id, item]),
  );
  if (!editable.size) return false;
  const attachments: DraftAttachment[] = [];
  for (const [index, attachment] of review.draft.attachments.entries()) {
    const entry = editable.get(draftId(index));
    if (!entry) {
      attachments.push(attachment);
      continue;
    }
    if (!kept.has(entry.id)) continue;
    try {
      const [checked] = await prepareDraftAttachments([attachment], embed);
      attachments.push({ ...checked, recovered: false });
    } catch {
      if (!isCurrent()) return false;
      throw new Error(S.unreadable(entry.label));
    }
    if (!isCurrent()) return false;
  }
  const replacements = new Map<number, PromptBlock[]>();
  for (const [index, blocks] of review.queue.entries()) {
    if (
      !review.entries.some(
        (entry) => !entry.locked && entry.id.startsWith(`queue:${index}:`),
      )
    )
      continue;
    const replacement: PromptBlock[] = [];
    for (const [blockIndex, block] of blocks.entries()) {
      const entry = editable.get(queueId(index, blockIndex));
      if (!entry) {
        replacement.push(structuredClone(block));
        continue;
      }
      if (!kept.has(entry.id)) continue;
      const checked = structuredClone(block);
      try {
        await validateQueuedAttachments([checked]);
      } catch {
        if (!isCurrent()) return false;
        throw new Error(S.unreadable(entry.label));
      }
      if (!isCurrent()) return false;
      replacement.push(checked);
    }
    replacements.set(index, replacement);
  }
  if (!isCurrent()) return false;
  assertCurrent(review);
  const state = review.thread;
  if (state && replacements.size) {
    // Pause once before any confirmations remove the review barrier.
    threads.beginQueueEdit(state.key, replacements.keys().next().value!);
    for (const [index, replacement] of [...replacements].reverse()) {
      if (replacement.length)
        threads.replaceQueued(state.key, review.queue[index], replacement);
      else threads.dequeue(state.key, index);
      forgetRestoredQueueAttachments(review.queue[index]);
    }
  }
  if (
    review.entries.some(
      (entry) => !entry.locked && entry.id.startsWith("draft:"),
    )
  )
    composerDrafts.update(review.draftKey, () => ({
      ...review.draft,
      attachments,
    }));
  return true;
}
