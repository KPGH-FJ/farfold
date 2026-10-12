import { useEffect, useRef, useState } from "react";
import { ComposerAttachments } from "./ComposerAttachments";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { DocumentInputReview } from "./DocumentInputReview";
import type { DraftAttachment } from "../runtime/drafts";
import { draftPersistence } from "../runtime/draft_storage";
import { createDocumentInputTarget } from "../runtime/document_input_draft";
import {
  readDocumentInput,
  confirmDocumentInput,
  type DocumentInputReview as Review,
} from "../runtime/document_input";
import {
  DOCUMENT_INPUT_STRINGS as S,
  documentInputFailure,
} from "../runtime/document_input_strings";
import { localResourcePath } from "../runtime/file_delivery";
import type { ApprovedDocumentText } from "../runtime/document_input_types";

type Target = ReturnType<typeof createDocumentInputTarget>;
type Selection = {
  attachment: DraftAttachment;
  target: Target;
  context: string;
};
export function DocumentComposerAttachments({
  draftKey,
  context,
  enabled,
  items,
  onRemove,
}: {
  draftKey: string;
  context: string;
  enabled: boolean;
  items: readonly DraftAttachment[];
  onRemove: (id: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<Review | null>(null);
  const [partialSelected, setPartialSelected] = useState(false);
  const [working, setWorking] = useState<"reading" | "confirming" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DraftAttachment | null>(null);
  const [saved, setSaved] = useState<{
    draftKey: string;
    attachmentId: string;
    documentText: ApprovedDocumentText;
  } | null>(null);
  const live = useRef({ context, enabled, selection });
  live.current = { context, enabled, selection };
  const target = useRef<Target | null>(null);
  const close = () => {
    target.current?.retire();
    target.current = null;
    setSelection(null);
    setResult(null);
    setWorking(null);
    setError(null);
  };
  useEffect(() => {
    close();
    setView(null);
    setSaved(null);
    return () => {
      target.current?.retire();
      target.current = null;
    };
  }, [draftKey, context, enabled]);
  // The target observes draft/choice/storage changes synchronously. Render its
  // invalidation too, so a revoked result can never remain an actionable review.
  useEffect(() => {
    if (selection && !selection.target.isCurrent()) close();
    if (view && !items.includes(view)) setView(null);
  }, [items, selection, view]);
  const read = async (attachment: DraftAttachment) => {
    if (!enabled || !attachment.uri || target.current || working) return;
    setSaved(null);
    setError(null);
    setView(null);
    setPartialSelected(false);
    let ticket: Target | null = null;
    try {
      ticket = createDocumentInputTarget(
        draftKey,
        attachment,
        () => live.current.enabled && live.current.context === context,
      );
      target.current = ticket;
      const selected = { attachment, target: ticket, context };
      setSelection(selected);
      setWorking("reading");
      const task = readDocumentInput(
        { uri: attachment.uri, name: attachment.name },
        ticket.signal,
      );
      draftPersistence.trackAttachment(task);
      const readResult = await task;
      if (target.current === ticket && ticket.isCurrent()) {
        setResult(readResult);
        setWorking(null);
      }
    } catch (reason) {
      // A cancelled read may reject after a newer review has started. Its
      // callback belongs only to its original ticket, including failures.
      if (ticket && target.current !== ticket) return;
      if (ticket?.isCurrent()) {
        setError(documentInputFailure(reason));
        setWorking(null);
      } else if (ticket) close();
      else if (live.current.enabled && live.current.context === context)
        setError(documentInputFailure(reason));
    }
  };
  const confirm = async () => {
    if (!selection || !result || working || !selection.target.isCurrent())
      return;
    const ticket = selection.target;
    setWorking("confirming");
    setError(null);
    try {
      await draftPersistence.flush();
      if (!ticket.isCurrent()) return;
      const task = confirmDocumentInput(
        result,
        { partialSelected },
        ticket.signal,
      );
      draftPersistence.trackAttachment(task);
      const approved = await task;
      if (target.current !== ticket || !ticket.apply(approved)) return;
      // Approval only changes this unsent attachment. Flush independently of
      // the capture task, preserving memory and the global save error on failure.
      target.current = null;
      setSelection(null);
      setResult(null);
      setWorking(null);
      try {
        await draftPersistence.flush();
        if (live.current.context === context)
          setSaved({
            draftKey,
            attachmentId: selection.attachment.id,
            documentText: approved,
          });
      } catch {
        if (live.current.context === context) setError(S.saveFailed);
      }
    } catch (reason) {
      if (target.current !== ticket) return;
      if (ticket.isCurrent()) {
        setError(documentInputFailure(reason));
        setWorking(null);
      } else close();
    }
  };
  const candidate = (item: DraftAttachment) =>
    item.kind === "file" &&
    !!item.uri &&
    (!!item.documentText ||
      /\.docx$/i.test(item.name) ||
      /\.docx$/i.test(localResourcePath(item.uri) ?? ""));
  return (
    <>
      <ComposerAttachments
        items={items}
        onRemove={onRemove}
        action={(item) =>
          candidate(item) ? (
            <>
              {item.documentText && (
                <small className="document-input-state">
                  {item.documentText.local ? S.approved : S.needsSource}
                </small>
              )}
              {item.documentText && (
                <button
                  type="button"
                  className="document-input-action"
                  disabled={!enabled || !!working}
                  onClick={() => setView(item)}
                >
                  {S.view}
                </button>
              )}
              <button
                type="button"
                className="document-input-action"
                disabled={!enabled || !!working || items.some((a) => a.loading)}
                onClick={() => void read(item)}
              >
                {item.documentText ? S.reread : S.read}
              </button>
            </>
          ) : null
        }
      />
      {saved?.draftKey === draftKey &&
        items.some(
          (item) =>
            item.id === saved.attachmentId &&
            item.documentText === saved.documentText,
        ) && (
          <p role="status" className="composer-command-hint">
            {S.saved}
          </p>
        )}
      {!selection && error && (
        <p role="alert" className="composer-command-hint">
          {error}
        </p>
      )}
      {selection && selection.context === context && (
        <DocumentInputReview
          name={selection.attachment.name}
          result={result}
          previousText={selection.attachment.documentText?.text}
          partialSelected={partialSelected}
          onPartialSelected={setPartialSelected}
          busy={working}
          error={error}
          onConfirm={() => void confirm()}
          onClose={close}
        />
      )}
      {view?.documentText && (
        <WorkspaceDialog title={S.savedText} onClose={() => setView(null)}>
          <div className="workspace-dialog-body document-input-review">
            <strong>{view.name}</strong>
            <p>{view.documentText.local ? S.sourceVersion : S.restored}</p>
            <textarea
              aria-label={S.savedText}
              value={view.documentText.text}
              readOnly
            />
          </div>
          <footer>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setView(null)}
            >
              {S.cancel}
            </button>
          </footer>
        </WorkspaceDialog>
      )}
    </>
  );
}
