import { pendingPreparationRead } from "../runtime/agent_preparation";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import type { ThreadState } from "../runtime/session_types";
import { composerDrafts, useComposerDraft } from "../runtime/drafts";
import { draftPersistence } from "../runtime/draft_storage";
import { threads } from "../runtime/sessions";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { Composer } from "./Composer";

/** Reuse dispatch, attachment checks and queue ownership; the main draft is untouched. */
export function MessageResendDialog({
  thread,
  imageEnabled,
  embedContext,
  continued,
  onClose,
  onGoSettings,
}: {
  thread: ThreadState;
  imageEnabled: boolean;
  embedContext: boolean;
  continued: boolean;
  onClose: () => void;
  onGoSettings: () => void;
}) {
  const key = `resend:${thread.key}`;
  const draft = useComposerDraft(key);
  const readRequired =
    thread.identity === "draft" && pendingPreparationRead(thread);
  return (
    <WorkspaceDialog
      title={R.editMessage}
      busy={draft.sendPending}
      onClose={onClose}
    >
      <div className="conversation-message-editor">
        <p>{R.resendNote}</p>
        <p>{R.resendDraftKept}</p>
        {continued && <p role="status">{R.resendContinue}</p>}
        <Composer
          thread={thread}
          draftKey={key}
          imageEnabled={imageEnabled}
          embedContext={embedContext}
          onGoSettings={onGoSettings}
          fit
          disabled={readRequired}
          note={readRequired ? C.readRequired : undefined}
          prepareAction={readRequired ? onGoSettings : undefined}
          sendActionLabel={R.resendSend}
          onSend={async (blocks) => {
            if (threads.thread(thread.key) !== thread) return false;
            if (thread.identity === "draft" && pendingPreparationRead(thread))
              throw new Error(C.readRequired);
            await threads.send(thread.key, blocks);
            // The existing queue owns rejected/unknown submissions as well; it is
            // persisted before the editor closes and never retried here.
            await draftPersistence.flush().catch(() => undefined);
            onClose();
          }}
        />
        <footer>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={draft.sendPending}
            onClick={() => {
              composerDrafts.clear(key);
              onClose();
            }}
          >
            {R.resendDiscard}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={draft.sendPending}
            onClick={onClose}
          >
            {R.resendKeep}
          </button>
        </footer>
      </div>
    </WorkspaceDialog>
  );
}
