import { threads, type PromptBlock } from "./sessions";
import { STRINGS } from "./strings";
import { promptRejectionNotice } from "./prompt_blocks";

/** First-message rejection belongs back in the editor, not a hidden queue. */
export async function sendNewConversation(key: string, blocks: PromptBlock[]) {
  const result = await threads.send(key, blocks);
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
