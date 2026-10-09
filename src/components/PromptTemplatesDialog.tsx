import { useRef, useState, type RefObject } from "react";
import {
  promptTemplates,
  usePromptTemplates,
  type PromptTemplate,
} from "../runtime/prompt_templates";
import { templateEditDrafts, useTemplateEditDraft } from "../runtime/drafts";
import { draftPersistence, useDraftSaveStatus } from "../runtime/draft_storage";
import { PROMPT_TEMPLATES as S } from "../runtime/prompt_template_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { uiError } from "../runtime/ui_error";

/** Template management never owns a conversation or dispatches a prompt. */
export function PromptTemplatesDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const state = usePromptTemplates();
  const edit = useTemplateEditDraft();
  const drafts = useDraftSaveStatus();
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const locked =
    working || state.saving || !drafts.ready || !!drafts.interactionLocked;
  const writable = state.ready && !state.uncertain && !locked;
  const current = edit
    ? state.items.find((item) => item.id === edit.id)
    : undefined;
  const saved =
    !!edit &&
    !!current &&
    current.label === edit.label &&
    current.text === edit.text;
  const conflict =
    !!edit &&
    (edit.original
      ? !current ||
        current.label !== edit.original.label ||
        current.text !== edit.original.text
      : !!current);
  const editableNow = () => {
    const currentDrafts = draftPersistence.snapshot();
    return (
      !busy.current &&
      !promptTemplates.snapshot().saving &&
      currentDrafts.ready &&
      !currentDrafts.interactionLocked
    );
  };
  const act = async (operation: () => Promise<void>) => {
    if (!editableNow()) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(uiError(reason, S.saveFailed));
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };
  const start = (item?: PromptTemplate) => {
    if (!writable || !editableNow() || templateEditDrafts.read()) return;
    templateEditDrafts.update(
      item
        ? { ...item, original: { ...item } }
        : { id: crypto.randomUUID(), label: "", text: "" },
    );
    setDeleting(null);
    setError(null);
  };
  return (
    <WorkspaceDialog
      title={S.title}
      busy={locked}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="prompt-templates-body">
        <p>{S.note}</p>
        {state.notice && <p role="status">{state.notice}</p>}
        {(error || state.error || drafts.error) && (
          <p role="alert">{error ?? state.error ?? drafts.error}</p>
        )}
        {(!state.ready || state.uncertain || state.error) && (
          <div>
            <p role="status">{state.error ? S.errorStatus : S.loading}</p>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={locked}
              onClick={() => void act(() => promptTemplates.reload())}
            >
              {S.retry}
            </button>
            {state.uncertain && (
              <>
                <p>{S.unknownNote}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={locked}
                  onClick={() =>
                    void act(() => promptTemplates.recoverUnknown())
                  }
                >
                  {S.recoverUnknown}
                </button>
              </>
            )}
          </div>
        )}
        {edit ? (
          <form
            className="prompt-template-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !writable ||
                saved ||
                conflict ||
                !edit.label.trim() ||
                !edit.text.trim()
              )
                return;
              void act(async () => {
                await draftPersistence.flush();
                if (templateEditDrafts.read() !== edit)
                  throw new Error(S.changed);
                await promptTemplates.save(
                  { id: edit.id, label: edit.label, text: edit.text },
                  edit.original,
                );
                if (templateEditDrafts.read() === edit) {
                  templateEditDrafts.update(null);
                  await draftPersistence.flush();
                }
              });
            }}
          >
            <p>{S.editKept}</p>
            {writable && conflict && !saved && (
              <section className="prompt-template-conflict">
                <p>{S.conflict}</p>
                {current && (
                  <>
                    <strong>
                      {S.current}: {current.label}
                    </strong>
                    <pre className="prompt-template-preview">
                      {current.text}
                    </pre>
                  </>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    if (
                      templateEditDrafts.read() !== edit ||
                      !editableNow() ||
                      promptTemplates
                        .snapshot()
                        .items.find((item) => item.id === edit.id) !== current
                    )
                      return;
                    templateEditDrafts.update(
                      current
                        ? { ...edit, original: { ...current } }
                        : {
                            id: crypto.randomUUID(),
                            label: edit.label,
                            text: edit.text,
                          },
                    );
                    setError(null);
                  }}
                >
                  {current ? S.useCurrent : S.saveCopy}
                </button>
              </section>
            )}
            <label>
              {S.label}
              <input
                value={edit.label}
                maxLength={80}
                disabled={locked}
                onChange={(event) => {
                  if (
                    !locked &&
                    editableNow() &&
                    templateEditDrafts.read() === edit
                  )
                    templateEditDrafts.update({
                      ...edit,
                      label: event.target.value,
                    });
                }}
              />
            </label>
            <label>
              {S.body}
              <textarea
                value={edit.text}
                maxLength={32000}
                rows={8}
                disabled={locked}
                onChange={(event) => {
                  if (
                    !locked &&
                    editableNow() &&
                    templateEditDrafts.read() === edit
                  )
                    templateEditDrafts.update({
                      ...edit,
                      text: event.target.value,
                    });
                }}
              />
            </label>
            <footer>
              {saved && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!writable}
                  onClick={() =>
                    void act(async () => {
                      const latest = promptTemplates.snapshot();
                      const item = latest.items.find(
                        (item) => item.id === edit.id,
                      );
                      if (
                        templateEditDrafts.read() !== edit ||
                        !latest.ready ||
                        latest.uncertain ||
                        item?.label !== edit.label ||
                        item?.text !== edit.text
                      )
                        throw new Error(S.changed);
                      templateEditDrafts.update(null);
                      await draftPersistence.flush();
                    })
                  }
                >
                  {S.finishSaved}
                </button>
              )}
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  !writable ||
                  saved ||
                  conflict ||
                  !edit.label.trim() ||
                  !edit.text.trim()
                }
              >
                {working ? S.saving : S.save}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={locked}
                onClick={() => {
                  if (
                    !locked &&
                    editableNow() &&
                    templateEditDrafts.read() === edit
                  ) {
                    templateEditDrafts.update(null);
                    setError(null);
                  }
                }}
              >
                {S.discard}
              </button>
            </footer>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!writable}
              onClick={() => start()}
            >
              {S.new}
            </button>
            {state.ready && !state.items.length && <p>{S.empty}</p>}
            <ul className="prompt-template-list">
              {state.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.label}</strong>
                  <p className="prompt-template-preview">{item.text}</p>
                  {deleting === item ? (
                    <div>
                      <p>{S.deleteNote}</p>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={!writable}
                        onClick={() =>
                          void act(async () => {
                            await promptTemplates.remove(item);
                            setDeleting(null);
                          })
                        }
                      >
                        {S.confirmDelete}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={locked}
                        onClick={() => setDeleting(null)}
                      >
                        {S.cancel}
                      </button>
                    </div>
                  ) : (
                    <div>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!writable}
                        onClick={() => start(item)}
                      >
                        {S.edit}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!writable}
                        onClick={() => setDeleting(item)}
                      >
                        {S.delete}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </WorkspaceDialog>
  );
}
