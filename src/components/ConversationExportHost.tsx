import { useState, type RefObject } from "react";
import type { ConversationExportSnapshot } from "../runtime/conversation_archive_snapshot";
import { EXPORT_STRINGS as E } from "../runtime/export_strings";
import { ARCHIVE_STRINGS as S } from "../runtime/conversation_archive_strings";
import { ConversationExportDialog } from "./ConversationExportDialog";
import { ConversationArchiveDialog } from "./ConversationArchiveDialog";
/** Both conversation entrypoints use the same frozen capture and explicit choices. */
export function ConversationExportHost({
  capture,
  name,
  onClose,
  returnFocusRef,
  onRegistered,
}: {
  capture: ConversationExportSnapshot;
  name: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  onRegistered: () => void;
}) {
  const [format, setFormat] = useState<"markdown" | "zip">("markdown");
  const [includeDetails, setIncludeDetails] = useState(false);
  const unavailable =
    format === "zip"
      ? includeDetails
        ? capture.unavailable.archiveDetails
        : capture.unavailable.archive
      : includeDetails
        ? capture.unavailable.details
        : capture.unavailable.markdown;
  const detailsUnavailable =
    format === "zip"
      ? capture.unavailable.archiveDetails
      : capture.unavailable.details;
  const formatControls = (busy: boolean) => (
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <label>
        {S.format}
        <select
          value={format}
          onChange={(e) =>
            setFormat(e.target.value === "zip" ? "zip" : "markdown")
          }
        >
          <option value="markdown">{S.markdown}</option>
          <option value="zip" disabled={capture.unavailable.archive}>
            {S.zip}
          </option>
        </select>
      </label>
      {capture.toolDetailCount > 0 && (
        <label style={{ display: "block", marginTop: 8 }}>
          <input
            type="checkbox"
            disabled={detailsUnavailable && !includeDetails}
            checked={includeDetails}
            onChange={(e) => setIncludeDetails(e.target.checked)}
          />{" "}
          包含{E.loadedDetails}（{capture.toolDetailCount} 项）
        </label>
      )}
      {(unavailable || detailsUnavailable || capture.unavailable.archive) && (
        <p role="status">
          部分导出选项超过大小或数量限制；仍可选择可用的文字快照。
        </p>
      )}
    </fieldset>
  );
  return format === "markdown" ? (
    <ConversationExportDialog
      unavailable={unavailable}
      includeLoadedToolDetails={includeDetails}
      text={includeDetails ? capture.detailedMarkdown : capture.markdown}
      name={name}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      formatControls={formatControls}
    />
  ) : (
    <ConversationArchiveDialog
      capture={capture}
      name={name}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      formatControls={formatControls}
      includeDetails={includeDetails}
      onRegistered={onRegistered}
    />
  );
}
