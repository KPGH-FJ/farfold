import {
  diagnosticsReview,
  useDiagnosticsReview,
  DIAGNOSTIC_STRINGS as S,
} from "../runtime/diagnostics";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const state = useDiagnosticsReview();
  const busy = state.phase === "loading" || state.phase === "exporting";
  return (
    <WorkspaceDialog title={S.title} onClose={onClose}>
      <div className="workspace-dialog-body diagnostics-review">
        <p>{S.scope}</p>
        <p>{S.local}</p>
        {(state.phase === "edit" || state.phase === "loading") && (
          <label>
            <span>{S.note}</span>
            <textarea
              rows={4}
              value={state.note}
              maxLength={4000}
              disabled={busy}
              placeholder={S.notePlaceholder}
              onChange={(event) =>
                diagnosticsReview.setNote(event.target.value)
              }
            />
            <small>{S.noteHint}</small>
          </label>
        )}
        {state.preview && state.phase !== "edit" && (
          <>
            <p>{state.phase === "done" ? S.done : S.review}</p>
            {state.phase === "done" && state.path && (
              <p className="diagnostics-path" role="status">
                {state.path}
              </p>
            )}
            {state.phase !== "done" &&
              state.preview.entries.map((entry) => (
                <details
                  key={entry.name}
                  className="diagnostics-entry"
                  open={entry.name === "user-note.txt"}
                >
                  <summary>{entry.name}</summary>
                  <pre>{entry.text}</pre>
                </details>
              ))}
            {state.phase === "done" && state.note.trim() && (
              <div>
                <strong>{S.note}</strong>
                <p className="diagnostics-note">{state.note}</p>
              </div>
            )}
          </>
        )}
        {busy && <p role="status">{S.background}</p>}
        {state.error && (
          <p className="ac-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
      <footer>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {S.close}
        </button>
        {state.phase === "edit" || state.phase === "loading" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void diagnosticsReview.prepare()}
          >
            {busy ? S.previewing : S.preview}
          </button>
        ) : state.phase === "done" ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={diagnosticsReview.showPreview}
          >
            {S.contents}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-text"
              disabled={busy}
              onClick={diagnosticsReview.edit}
            >
              {S.edit}
            </button>
            {busy && <p role="status">{S.background}</p>}
            {state.error && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void diagnosticsReview.prepare()}
              >
                {S.refresh}
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void diagnosticsReview.export()}
            >
              {busy ? S.exporting : S.export}
            </button>
          </>
        )}
      </footer>
    </WorkspaceDialog>
  );
}
