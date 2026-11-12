import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { fileDelivery } from "../runtime/file_delivery";
import { EXPORT_STRINGS as E } from "../runtime/export_strings";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";

export function ConversationExportDialog({
  text,
  name,
  onClose,
  returnFocusRef,
  formatControls,
  includeLoadedToolDetails = false,
  unavailable = false,
}: {
  includeLoadedToolDetails?: boolean;
  unavailable?: boolean;
  formatControls?: (busy: boolean) => ReactNode;
  text: string;
  name: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writing = useRef<object | null>(null);
  const live = useRef({ active: false, text, name, includeLoadedToolDetails });
  useLayoutEffect(() => {
    const owner = { active: true, text, name, includeLoadedToolDetails };
    live.current = owner;
    setSaved(null);
    setCancelled(false);
    setError(null);
    setSaving(writing.current !== null);
    return () => {
      owner.active = false;
    };
  }, [text, name, includeLoadedToolDetails]);
  const close = () => {
    if (!writing.current) {
      live.current.active = false;
      onClose();
    }
  };
  const exportText = async () => {
    const owner = live.current;
    const current = () => owner.active && live.current === owner;
    if (
      writing.current ||
      unavailable ||
      !current() ||
      owner.text !== text ||
      owner.name !== name ||
      owner.includeLoadedToolDetails !== includeLoadedToolDetails
    )
      return;
    const attempt = {};
    writing.current = attempt;
    setSaving(true);
    setError(null);
    setSaved(null);
    setCancelled(false);
    try {
      const destination = await save({
        defaultPath: name,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!current()) return;
      if (destination) {
        await fileDelivery.exportText(text, destination);
        if (current()) setSaved(destination);
      } else {
        setCancelled(true);
      }
    } catch {
      if (current()) setError(E.failed);
    } finally {
      // A dispatched write still owns its wait; hiding cannot cancel OS work.
      if (writing.current === attempt) {
        writing.current = null;
        if (live.current.active) setSaving(false);
      }
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
        {formatControls?.(saving)}
        <strong role="status">
          {saving
            ? R.exportSaving
            : saved
              ? R.exportSaved
              : error
                ? E.unconfirmed
                : cancelled
                  ? E.cancelled
                  : R.exportReady}
        </strong>
        <code>{saved ?? name}</code>
        <p>{E.dialogSummary}</p>
        <details>
          <summary>{E.details}</summary>
          <p>{E.dialogScope}</p>
          <p>
            {includeLoadedToolDetails
              ? E.detailsExcludedScope
              : E.excludedScope}
          </p>
          {includeLoadedToolDetails && <p>{E.detailsScope}</p>}
          <p>{E.attachmentsScope}</p>
          <p>{E.lineScope}</p>
          <p>
            {includeLoadedToolDetails ? E.detailsPrivacyScope : E.privacyScope}
          </p>
        </details>
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
            disabled={saving || unavailable}
            onClick={() => void exportText()}
          >
            {R.exportSave}
          </button>
        </footer>
      </div>
    </WorkspaceDialog>
  );
}
