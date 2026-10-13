import type { AudioSourceConfirmation } from "../runtime/audio_source_error";
import { useAudioComposerAttachments } from "./useAudioComposerAttachments";
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
import type { PdfInputRequest } from "../runtime/pdf_input_types";
import { documentMediaFormat } from "../runtime/document_media_type";

type Target = ReturnType<typeof createDocumentInputTarget>;
type Selection = {
  attachment: DraftAttachment;
  target: Target;
  context: string;
  xlsx?: XlsxInputRequest;
  pdf?: PdfInputRequest;
  pdfScopeRequired: boolean;
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
const isPdf = (attachment: DraftAttachment) =>
  attachment.documentText?.local?.format === "pdf" ||
  documentMediaFormat(attachment.mimeType) === "pdf" ||
  /\.pdf$/i.test(attachment.name) ||
  /\.pdf$/i.test(localResourcePath(attachment.uri ?? "") ?? "");
function initialPdfRequest(
  attachment: DraftAttachment,
): PdfInputRequest | undefined {
  const local = attachment.documentText?.local;
  return local?.format === "pdf" &&
    localResourcePath(attachment.uri ?? "") === local.source.path
    ? {
        mode: local.scope.mode,
        includePossiblyInvisibleText: local.scope.includePossiblyInvisibleText,
      }
    : undefined;
}
export function DocumentComposerAttachments({
  draftKey,
  context,
  enabled,
  items,
  onRemove,
  onSaved,
  audioCapability,
  onAudioSaved,
}: {
  draftKey: string;
  context: string;
  enabled: boolean;
  audioCapability?: boolean;
  onAudioSaved?: (confirmation: AudioSourceConfirmation) => void;
  items: readonly DraftAttachment[];
  onRemove: (id: string) => void;
  onSaved?: (confirmation: DocumentSourceConfirmation) => void;
}) {
  const audio = useAudioComposerAttachments({
    draftKey,
    context,
    enabled,
    items,
    capability: audioCapability,
    onSaved: onAudioSaved,
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [result, setResult] = useState<Review | null>(null);
  const [partialSelected, setPartialSelected] = useState(false);
  const [pdfScopeSelected, setPdfScopeSelected] = useState(false);
  const [working, setWorking] = useState<"reading" | "confirming" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DraftAttachment | null>(null);
  const [saved, setSaved] = useState<{
    draftKey: string;
    attachmentId: string;
    documentText: ApprovedDocumentText;
  } | null>(null);
  const live = useRef({
    draftKey,
    context,
    enabled,
    selection,
    result,
    working,
  });
  live.current = { draftKey, context, enabled, selection, result, working };
  const updateWorking = (value: typeof working) => {
    live.current.working = value;
    setWorking(value);
  };
  const target = useRef<Target | null>(null);
  const readsStarted = useRef(new WeakSet<Target>());
  const saveNotice = useRef<ReturnType<typeof watchDraftSave> | null>(null);
  const close = () => {
    saveNotice.current?.retire();
    saveNotice.current = null;
    target.current?.retire();
    target.current = null;
    setSelection(null);
    setResult(null);
    updateWorking(null);
    setError(null);
    setPdfScopeSelected(false);
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
  const readSelected = async (selected: Selection) => {
    const { attachment, target: ticket, xlsx, pdf } = selected;
    if (
      target.current !== ticket ||
      !ticket.isCurrent() ||
      !attachment.uri ||
      selected.pdfScopeRequired ||
      readsStarted.current.has(ticket)
    )
      return;
    readsStarted.current.add(ticket);
    try {
      updateWorking("reading");
      const task = readDocumentInput(
        { uri: attachment.uri, name: attachment.name },
        ticket.signal,
        pdf ? { pdf } : xlsx ? { xlsx } : undefined,
      );
      draftPersistence.trackAttachment(task);
      const readResult = await task;
      if (target.current === ticket && ticket.isCurrent()) {
        setResult(readResult);
        updateWorking(null);
      }
    } catch (reason) {
      // A cancelled read may reject after a newer review has started. Its
      // callback belongs only to its original ticket, including failures.
      if (target.current !== ticket) return;
      if (ticket.isCurrent()) {
        setError(documentInputFailure(reason));
        updateWorking(null);
      } else close();
    }
  };
  const read = (
    attachment: DraftAttachment,
    xlsx: XlsxInputRequest | undefined = initialXlsxRequest(attachment),
    pdf: PdfInputRequest | undefined = initialPdfRequest(attachment),
  ) => {
    if (!enabled || !attachment.uri || target.current || working) return;
    saveNotice.current?.retire();
    saveNotice.current = null;
    setSaved(null);
    setError(null);
    setView(null);
    setPartialSelected(false);
    setPdfScopeSelected(false);
    try {
      const ticket = createDocumentInputTarget(
        draftKey,
        attachment,
        () => live.current.enabled && live.current.context === context,
      );
      target.current = ticket;
      const selected: Selection = {
        attachment,
        target: ticket,
        context,
        xlsx,
        pdf,
        pdfScopeRequired: isPdf(attachment) && !pdf,
      };
      setSelection(selected);
      // New/unknown PDF sources need an active range choice before any file
      // inspection or extraction. The existing target protects that choice too.
      if (!selected.pdfScopeRequired) void readSelected(selected);
    } catch (reason) {
      if (live.current.enabled && live.current.context === context)
        setError(documentInputFailure(reason));
    }
  };
  const readPdfScope = () => {
    if (
      !selection?.pdfScopeRequired ||
      !pdfScopeSelected ||
      working ||
      target.current !== selection.target ||
      !selection.target.isCurrent()
    )
      return;
    const selected: Selection = {
      ...selection,
      pdf: { mode: "decoded-page-text", includePossiblyInvisibleText: true },
      xlsx: undefined,
      pdfScopeRequired: false,
    };
    setSelection(selected);
    void readSelected(selected);
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
    updateWorking("confirming");
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
      updateWorking(null);
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
        updateWorking(null);
      } else close();
    }
  };
  const candidate = (item: DraftAttachment) =>
    item.kind === "file" &&
    !!item.uri &&
    (!!item.documentText ||
      /\.docx$/i.test(item.name) ||
      /\.docx$/i.test(localResourcePath(item.uri) ?? "") ||
      isPdf(item) ||
      isSpreadsheet(item));
  return (
    <>
      <ComposerAttachments
        items={items}
        onRemove={onRemove}
        action={(item) =>
          audio.action(item) ??
          (candidate(item) ? (
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
          ) : null)
        }
      />
      {audio.dialog}
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
          onPartialSelected={(selected) => {
            if (
              target.current === selection.target &&
              live.current.selection === selection &&
              result !== null &&
              live.current.result === result &&
              !live.current.working &&
              live.current.enabled &&
              live.current.draftKey === draftKey &&
              live.current.context === selection.context &&
              selection.target.isCurrent()
            )
              setPartialSelected(selected);
          }}
          busy={working}
          error={error}
          onConfirm={() => void confirm()}
          onClose={close}
          xlsxRequest={selection.xlsx}
          onXlsxRequest={changeXlsxRequest}
          pdfRequest={selection.pdf}
          pdfScopeRequired={selection.pdfScopeRequired}
          pdfScopeSelected={pdfScopeSelected}
          onPdfScopeSelected={(selected) => {
            if (
              target.current === selection.target &&
              selection.pdfScopeRequired &&
              selection.target.isCurrent()
            )
              setPdfScopeSelected(selected);
          }}
          onReadPdf={readPdfScope}
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
