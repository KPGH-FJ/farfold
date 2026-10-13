import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";
import { PDF_INPUT_SCOPE_TEXT } from "../runtime/pdf_input_text";
import { PDF_INPUT_SCOPE_WARNING_CODES } from "../runtime/pdf_input_types";

/** A choice only: never reads bytes, previews content, or grants source authority. */
export function PdfInputScopeChoice({
  selected,
  onSelected,
  disabled,
}: {
  selected: boolean;
  onSelected: (selected: boolean) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>{S.pdfRange}</legend>
      <p>{S.pdfDecodedText}</p>
      <ul>
        {PDF_INPUT_SCOPE_WARNING_CODES.map((code) => (
          <li key={code}>{PDF_INPUT_SCOPE_TEXT[code]}</li>
        ))}
      </ul>
      <label className="document-input-consent">
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelected(event.target.checked)}
        />
        <span>{S.pdfInvisibleConsent}</span>
      </label>
    </fieldset>
  );
}
