import { useRef, useState, type RefObject } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { fileDelivery } from "../runtime/file_delivery";
import { uiError } from "../runtime/ui_error";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function ConversationExportDialog({
  text,
  name,
  onClose,
  returnFocusRef,
}: {
  text: string;
  name: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writing = useRef(false);
  const close = () => {
    if (!writing.current) onClose();
  };
  const exportText = async () => {
    if (writing.current) return;
    writing.current = true;
    setSaving(true);
    setError(null);
    try {
      const destination = await save({
        defaultPath: name,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (destination) {
        await fileDelivery.exportText(text, destination);
        setSaved(destination);
      }
    } catch (reason) {
      setError(uiError(reason, R.exportFailed));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  return (
    <WorkspaceDialog
      title={R.exportTitle}
      busy={saving}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <div className="conversation-export-body">
        <strong role="status">
          {saving ? R.exportSaving : saved ? R.exportSaved : R.exportReady}
        </strong>
        <code>{saved ?? name}</code>
        <p>{R.exportScope}</p>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            onClick={close}
          >
            {R.exportClose}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void exportText()}
          >
            {R.exportSave}
          </button>
        </footer>
      </div>
    </WorkspaceDialog>
  );
}
