import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";
import { documentInputPresentation } from "../runtime/document_input_presentation";
import type { DocumentInputReview as Review } from "../runtime/document_input";
import type { XlsxInputRequest } from "../runtime/xlsx_input_types";
import type { PdfInputRequest } from "../runtime/pdf_input_types";
import { PdfInputScopeChoice } from "./PdfInputScopeChoice";
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
  xlsxRequest,
  onXlsxRequest,
  pdfRequest,
  pdfScopeRequired = false,
  pdfScopeSelected = false,
  onPdfScopeSelected,
  onReadPdf,
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
  xlsxRequest?: XlsxInputRequest;
  onXlsxRequest?: (request: XlsxInputRequest) => void;
  pdfRequest?: PdfInputRequest;
  pdfScopeRequired?: boolean;
  pdfScopeSelected?: boolean;
  onPdfScopeSelected?: (selected: boolean) => void;
  onReadPdf?: () => void;
}) {
  const presentation = result && documentInputPresentation(result.local);
  return (
    <WorkspaceDialog title={S.title} onClose={onClose}>
      <div className="workspace-dialog-body document-input-review">
        <strong>{name}</strong>
        <p>
          {pdfRequest || pdfScopeRequired
            ? S.pdfScope
            : xlsxRequest
              ? S.xlsxScope
              : S.scope}
        </p>
        <p>{S.draftOnly}</p>
        {pdfScopeRequired && onPdfScopeSelected && (
          <PdfInputScopeChoice
            selected={pdfScopeSelected}
            onSelected={onPdfScopeSelected}
            disabled={!!busy}
          />
        )}
        {xlsxRequest && onXlsxRequest && (
          <fieldset disabled={!!busy}>
            <legend>{S.xlsxRange}</legend>
            {(["visible-saved-cells", "all-saved-cells"] as const).map(
              (mode) => (
                <label key={mode} className="document-input-consent">
                  <input
                    type="radio"
                    name="document-input-range"
                    checked={xlsxRequest.mode === mode}
                    onChange={() => onXlsxRequest({ mode })}
                  />
                  <span>
                    {mode === "all-saved-cells" ? S.xlsxAll : S.xlsxVisible}
                  </span>
                </label>
              ),
            )}
            <p>
              {xlsxRequest.mode === "all-saved-cells"
                ? S.xlsxAllDetails
                : S.xlsxVisibleDetails}
            </p>
          </fieldset>
        )}
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
        {result && presentation && (
          <>
            <p>{presentation.count}</p>
            {presentation.sheetCount && <p>{presentation.sheetCount}</p>}
            {presentation.pageCount && <p>{presentation.pageCount}</p>}
            <p>{S.sourceVersion}</p>
            <details open={result.local.partial}>
              <summary>{S.omissions}</summary>
              {result.local.partial && <p>{S.scopePartial}</p>}
              <ul>
                {presentation.warnings.map((warning) => (
                  <li key={warning.code}>
                    {warning.text} ({warning.countText})
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
        {pdfScopeRequired ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy || !pdfScopeSelected || !onReadPdf}
            onClick={onReadPdf}
          >
            {S.pdfReadSelected}
          </button>
        ) : (
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
        )}
      </footer>
    </WorkspaceDialog>
  );
}
