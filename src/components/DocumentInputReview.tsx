import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";
import { DOCUMENT_WARNINGS } from "../runtime/document_strings";
import type { DocumentInputReview as Review } from "../runtime/document_input";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "../document-input.css";

export function DocumentInputReview({
  name,
  result,
  previousText,
  partialSelected,
  onPartialSelected,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  name: string;
  result: Review | null;
  previousText?: string;
  partialSelected: boolean;
  onPartialSelected: (value: boolean) => void;
  busy: "reading" | "confirming" | null;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <WorkspaceDialog title={S.title} onClose={onClose}>
      <div className="workspace-dialog-body document-input-review">
        <strong>{name}</strong>
        <p>{S.scope}</p>
        <p>{S.draftOnly}</p>
        {busy && (
          <p role="status">{busy === "reading" ? S.loading : S.checking}</p>
        )}
        {previousText !== undefined && (
          <details>
            <summary>{S.previousText}</summary>
            <textarea
              aria-label={S.previousText}
              value={previousText}
              readOnly
            />
          </details>
        )}
        {result && (
          <>
            <p>
              {S.count(result.local.utf8Bytes, result.local.imageReferences)}
            </p>
            <p>{S.sourceVersion}</p>
            <details open={result.local.partial}>
              <summary>{S.omissions}</summary>
              {result.local.partial && <p>{S.scopePartial}</p>}
              <ul>
                {result.local.warnings.map((warning) => (
                  <li key={warning.code}>
                    {DOCUMENT_WARNINGS[warning.code]} ({warning.count})
                  </li>
                ))}
              </ul>
            </details>
            <label>
              {S.allText}
              <textarea value={result.text} readOnly />
            </label>
            {result.local.partial && (
              <label className="document-input-consent">
                <input
                  type="checkbox"
                  checked={partialSelected}
                  disabled={!!busy}
                  onChange={(event) => onPartialSelected(event.target.checked)}
                />
                <span>{S.partialConsent}</span>
              </label>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {S.cancel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            !!busy || !result || (result.local.partial && !partialSelected)
          }
          onClick={onConfirm}
        >
          {result?.local.partial ? S.confirmPartial : S.confirm}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
