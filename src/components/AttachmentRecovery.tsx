import { useEffect, useRef, useState } from "react";
import { useComposerDraft } from "../runtime/drafts";
import {
  attachmentReviewEntries,
  captureAttachmentReview,
  confirmAttachmentReview,
  type AttachmentReview,
} from "../runtime/attachment_review";
import { ATTACHMENT_REVIEW as S } from "../runtime/attachment_review_strings";
import type { ThreadState } from "../runtime/session_types";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "../attachment-review.css";

export function AttachmentRecovery({
  draftKey,
  thread,
  embed,
  active,
}: {
  draftKey: string;
  thread: ThreadState | null;
  embed: boolean;
  active: boolean;
}) {
  const draft = useComposerDraft(draftKey);
  const [review, setReview] = useState<AttachmentReview | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const attempt = useRef(0);
  const current = useRef({ draftKey, thread, active, review });
  current.current = { draftKey, thread, active, review };
  const close = () => {
    attempt.current++;
    setChecking(false);
    setReview(null);
  };
  useEffect(() => {
    close();
    setDone(false);
    return () => {
      attempt.current++;
    };
  }, [active, draftKey, thread?.key]);
  const entries = attachmentReviewEntries(draft, thread);
  const open = () => {
    const snapshot = captureAttachmentReview(draftKey, thread);
    setReview(snapshot);
    setKept(new Set(snapshot.entries.map((entry) => entry.id)));
    setError(null);
    setDone(false);
  };
  const confirm = async () => {
    if (!review || checking) return;
    const ticket = ++attempt.current;
    const isCurrent = () =>
      ticket === attempt.current &&
      current.current.active &&
      current.current.draftKey === review.draftKey &&
      current.current.thread === review.thread &&
      current.current.review === review;
    setChecking(true);
    setError(null);
    try {
      if (await confirmAttachmentReview(review, kept, embed, isCurrent)) {
        setDone(true);
        close();
      }
    } catch (reason) {
      if (isCurrent())
        setError(reason instanceof Error ? reason.message : S.changed);
    } finally {
      if (ticket === attempt.current) setChecking(false);
    }
  };
  return (
    <>
      {entries.length > 0 ? (
        <section className="attachment-recovery-notice" aria-label={S.title}>
          <div>
            <strong>{S.title}</strong>
            <p>{S.hint}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!active}
            onClick={open}
          >
            {S.open}
          </button>
        </section>
      ) : done ? (
        <p role="status" className="attachment-recovery-done">
          {S.done}
        </p>
      ) : null}
      {active &&
        review &&
        review.draftKey === draftKey &&
        review.thread === thread && (
          <WorkspaceDialog title={S.title} onClose={close}>
            <div className="workspace-dialog-body">
              <p>{S.details}</p>
              <p>{S.emptyQueue}</p>
              <div className="attachment-review-list">
                {review.entries.map((entry) => (
                  <label key={entry.id}>
                    <input
                      type="checkbox"
                      checked={kept.has(entry.id)}
                      disabled={checking || !!entry.locked}
                      onChange={(event) => {
                        setError(null);
                        setKept((previous) => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        });
                      }}
                    />
                    <span>
                      <strong>{entry.label}</strong>
                      <small>{entry.group}</small>
                      {entry.locked && <small>{entry.locked}</small>}
                    </span>
                  </label>
                ))}
              </div>
              {error && (
                <p role="alert" className="ac-error">
                  {error}
                </p>
              )}
            </div>
            <footer>
              <button type="button" className="btn btn-ghost" onClick={close}>
                {S.later}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  checking || !review.entries.some((entry) => !entry.locked)
                }
                onClick={() => void confirm()}
              >
                {checking ? S.checking : S.confirm}
              </button>
            </footer>
          </WorkspaceDialog>
        )}
    </>
  );
}
