import { useEffect, useRef, useState } from "react";
import { ComposerAttachments } from "./ComposerAttachments";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { DocumentInputReview } from "./DocumentInputReview";
import { DocumentTextDetails } from "./DocumentTextDetails";
import {
  composerDrafts,
  newConversationChoice,
  type DraftAttachment,
} from "../runtime/drafts";
import { draftPersistence } from "../runtime/draft_storage";
import { watchDraftSave } from "../runtime/draft_save_notice";
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
import type { DocumentSourceConfirmation } from "../runtime/document_source_error";
import type { XlsxInputRequest } from "../runtime/xlsx_input_types";

type Target = ReturnType<typeof createDocumentInputTarget>;
type Selection = {
  attachment: DraftAttachment;
  target: Target;
  context: string;
  xlsx?: XlsxInputRequest;
};
const isSpreadsheet = (attachment: DraftAttachment) =>
  attachment.documentText?.local?.format === "xlsx" ||
  /\.xlsx$/i.test(attachment.name) ||
  /\.xlsx$/i.test(localResourcePath(attachment.uri ?? "") ?? "");
function initialXlsxRequest(
  attachment: DraftAttachment,
): XlsxInputRequest | undefined {
  const local = attachment.documentText?.local;
  if (local?.format === "xlsx") return { mode: local.scope.mode };
  return isSpreadsheet(attachment)
    ? { mode: "visible-saved-cells" }
    : undefined;
}
export function DocumentComposerAttachments({
  draftKey,
  context,
  enabled,
  items,
  onRemove,
  onSaved,
}: {
  draftKey: string;
  context: string;
  enabled: boolean;
  items: readonly DraftAttachment[];
  onRemove: (id: string) => void;
  onSaved?: (confirmation: DocumentSourceConfirmation) => void;
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
  const live = useRef({ draftKey, context, enabled, selection });
  live.current = { draftKey, context, enabled, selection };
  const target = useRef<Target | null>(null);
  const saveNotice = useRef<ReturnType<typeof watchDraftSave> | null>(null);
  const close = () => {
    saveNotice.current?.retire();
    saveNotice.current = null;
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
      saveNotice.current?.retire();
      saveNotice.current = null;
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
  const read = async (
    attachment: DraftAttachment,
    xlsx: XlsxInputRequest | undefined = initialXlsxRequest(attachment),
  ) => {
    if (!enabled || !attachment.uri || target.current || working) return;
    saveNotice.current?.retire();
    saveNotice.current = null;
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
      const selected = { attachment, target: ticket, context, xlsx };
      setSelection(selected);
      setWorking("reading");
      const task = readDocumentInput(
        { uri: attachment.uri, name: attachment.name },
        ticket.signal,
        xlsx ? { xlsx } : undefined,
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
  const changeXlsxRequest = (request: XlsxInputRequest) => {
    if (!selection?.xlsx || working || !selection.target.isCurrent()) return;
    if (selection.xlsx.mode === request.mode) return;
    const attachment = selection.attachment;
    // Retire the old read and consent before reading the new range. The exact
    // original attachment is restored only while this ticket still owns it.
    close();
    void read(attachment, request);
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
      const applied = composerDrafts
        .read(draftKey)
        .attachments.find((item) => item.documentText === approved)!;
      // Approval only changes this unsent attachment. Flush independently of
      // the capture task, preserving memory and the global save error on failure.
      target.current = null;
      setSelection(null);
      setResult(null);
      setWorking(null);
      const generation = composerDrafts.generation(draftKey);
      const choice = JSON.stringify(newConversationChoice);
      const notice = watchDraftSave(
        draftPersistence.revision(),
        () => {
          const current = composerDrafts.read(draftKey);
          return (
            live.current.enabled &&
            live.current.draftKey === draftKey &&
            live.current.context === context &&
            target.current === null &&
            composerDrafts.generation(draftKey) === generation &&
            (draftKey !== "new" ||
              JSON.stringify(newConversationChoice) === choice) &&
            current.attachments.includes(applied) &&
            !current.sendPending &&
            !current.pendingConversation &&
            !applied.loading
          );
        },
        () => {
          if (saveNotice.current !== notice) return;
          saveNotice.current = null;
          setError(null);
          setSaved({
            draftKey,
            attachmentId: selection.attachment.id,
            documentText: approved,
          });
          onSaved?.({
            draftKey,
            attachment: selection.attachment,
            applied,
            approved,
          });
        },
      );
      saveNotice.current = notice;
      notice.check();
      try {
        await draftPersistence.flush();
        notice.check();
      } catch {
        if (saveNotice.current === notice && notice.isCurrent())
          setError(S.saveFailed);
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
      /\.docx$/i.test(localResourcePath(item.uri) ?? "") ||
      isSpreadsheet(item));
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
          xlsxRequest={selection.xlsx}
          onXlsxRequest={changeXlsxRequest}
        />
      )}
      {view?.documentText && (
        <WorkspaceDialog title={S.savedText} onClose={() => setView(null)}>
          <div className="workspace-dialog-body document-input-review">
            <strong>{view.name}</strong>
            <DocumentTextDetails document={view.documentText} />
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
