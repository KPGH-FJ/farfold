import type { ApprovedDocumentText } from "../runtime/document_input_types";
import { documentInputPresentation } from "../runtime/document_input_presentation";
import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";
import "../document-input.css";

/** Shows existing approved input, without reading a file or granting authority. */
export function DocumentTextDetails({
  document,
}: {
  document: ApprovedDocumentText;
}) {
  const presentation =
    document.local && documentInputPresentation(document.local);
  return (
    <div className="document-input-review">
      <p>{document.local ? S.sourceVersion : S.restored}</p>
      {presentation && (
        <>
          {presentation.xlsxScopeMode && (
            <p>
              {S.xlsxSavedScope}：
              {presentation.xlsxScopeMode === "all-saved-cells"
                ? S.xlsxAll
                : S.xlsxVisible}
            </p>
          )}
          <p>{presentation.scope}</p>
          <p>{presentation.count}</p>
          {presentation.sheetCount && <p>{presentation.sheetCount}</p>}
          <details open={document.local!.partial}>
            <summary>{S.omissions}</summary>
            {document.local!.partial && <p>{S.scopePartial}</p>}
            <ul>
              {presentation.warnings.map((warning) => (
                <li key={warning.code}>
                  {warning.text} ({warning.countText})
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <label>
        {S.savedText}
        <textarea aria-label={S.savedText} value={document.text} readOnly />
      </label>
    </div>
  );
}
