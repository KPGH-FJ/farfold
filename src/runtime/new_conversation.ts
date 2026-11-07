import { threads, type PromptBlock } from "./sessions";
import { STRINGS } from "./strings";
import { promptRejectionNotice } from "./prompt_blocks";
import { holdFirstPromptDraft } from "./prompt_admission";
import {
  finishPendingConversation,
  type PendingAttempt,
} from "./pending_conversation";

/** First-message rejection belongs back in the editor, not a hidden queue. */
export async function sendNewConversation(
  key: string,
  blocks: PromptBlock[],
  attempt?: PendingAttempt,
) {
  if (
    attempt &&
    (attempt.returnedToEditor ||
      threads.thread(key) !== attempt.state ||
      attempt.state.connectionId !== attempt.connectionId)
  )
    throw new Error(STRINGS.repair.sendFailed);
  const release =
    attempt &&
    holdFirstPromptDraft({
      blocks,
      attempt,
      returnDraft: () => finishPendingConversation(attempt, "rejected"),
    });
  const result = await threads.send(key, blocks).finally(() => release?.());
  if (attempt?.returnedToEditor) throw new Error(STRINGS.repair.sendFailed);
  const state = threads.thread(key);
  if (state?.identity === "established") return;
  if (state && !state.submitting && !state.uncertainPrompt) {
    const queued = state.queued.indexOf(blocks);
    if (queued >= 0) threads.dequeue(key, queued);
  }
  const notice =
    result.status === "rejected" ? promptRejectionNotice(result) : null;
  throw new Error(notice ?? STRINGS.repair.sendFailed);
}
