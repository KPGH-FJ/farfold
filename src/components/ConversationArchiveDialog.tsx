import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { ConversationArchiveJobsStatus } from "./ConversationArchiveJobsStatus";
import {
  ArchiveSelection,
  sourceBytes,
} from "../runtime/conversation_archive_selection";
import { conversationArchiveJobs } from "../runtime/conversation_archive_jobs";
import { archiveCode } from "../runtime/conversation_archive_parse";
import type { ConversationExportSnapshot } from "../runtime/conversation_archive_snapshot";
import type { ArchiveCode } from "../runtime/conversation_archive_types";
import { ARCHIVE_STRINGS as S } from "../runtime/conversation_archive_strings";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
export function ConversationArchiveDialog({
  capture,
  name,
  onClose,
  returnFocusRef,
  formatControls,
  includeDetails,
  onRegistered,
}: {
  capture: ConversationExportSnapshot;
  name: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  formatControls: (busy: boolean) => ReactNode;
  includeDetails: boolean;
  onRegistered: () => void;
}) {
  const [selection] = useState(() => new ArchiveSelection(capture));
  const rows = useSyncExternalStore(
    selection.subscribe,
    selection.getSnapshot,
    selection.getSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ArchiveCode | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const writing = useRef(false);
  const live = useRef({ active: true });
  useEffect(() => {
    const owner = { active: true };
    live.current = owner;
    selection.activate();
    return () => {
      owner.active = false;
      selection.retire();
    };
  }, [selection]);
  const close = () => {
    live.current.active = false;
    selection.retire();
    onClose();
  };
  const replace = async (id: string) => {
    const owner = live.current,
      revision = selection.version();
    setError(null);
    try {
      const path = await open({ directory: false, multiple: false });
      if (
        typeof path === "string" &&
        owner.active &&
        live.current === owner &&
        selection.version() === revision
      )
        await selection.replace(id, path);
    } catch {
      if (owner.active) setError("unavailable");
    }
  };
  const submit = async () => {
    if (writing.current || jobId) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    setCancelled(false);
    const owner = live.current;
    const current = () => owner.active && live.current === owner;
    try {
      const destination = await save({
        defaultPath: name.replace(/\.md$/i, "") + ".zip",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!current()) return;
      if (!destination) {
        setCancelled(true);
        return;
      }
      const input = await selection.prepare(
        destination,
        current,
        includeDetails,
      );
      if (input && current()) {
        const id = conversationArchiveJobs.begin(input);
        setJobId(id);
        selection.releasePayload();
        onRegistered();
      }
    } catch (e) {
      if (current()) setError(archiveCode(e));
    } finally {
      writing.current = false;
      if (current()) setBusy(false);
    }
  };
  const selected = rows.filter((r) => r.state === "selected");
  const blocked = rows.some(
    (r) => r.state === "checking" || r.state === "error",
  );
  return (
    <WorkspaceDialog
      title={R.exportTitle}
      returnFocusRef={returnFocusRef}
      onClose={close}
    >
      <div className="conversation-export-body">
        {!jobId && formatControls(busy)}
        {jobId ? (
          <>
            <p>{S.closeScope}</p>
            <ConversationArchiveJobsStatus operationId={jobId} />
          </>
        ) : (
          <>
            <p>{S.scope}</p>
            <details>
              <summary>范围与隐私</summary>
              <p>
                {includeDetails
                  ? "包含已载入的可读工具详情；不包含未载入历史、思考内容、草稿和待发内容。此包供阅读和移交。"
                  : S.detailScope}
              </p>
              <p>{S.privacy}</p>
            </details>
            <fieldset
              disabled={busy}
              style={{ border: 0, padding: 0, minWidth: 0 }}
            >
              <legend>{S.selection}</legend>
              {!rows.length && <p>{S.noAttachments}</p>}
              {rows.map((row) => {
                const c = row.candidate;
                return (
                  <div
                    key={c.candidateId}
                    style={{ paddingBlock: 8, overflowWrap: "anywhere" }}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={row.state !== "unchecked"}
                        disabled={c.source.kind === "unavailable"}
                        onChange={(e) =>
                          void selection.select(c.candidateId, e.target.checked)
                        }
                      />{" "}
                      {c.displayName || "附件"}
                    </label>
                    <small style={{ display: "block" }}>
                      第 {c.origin.itemOrdinal + 1} 项 ·{" "}
                      {c.origin.role === "user"
                        ? "用户"
                        : c.origin.role === "agent"
                          ? "助手"
                          : "工具"}{" "}
                      ·{" "}
                      {c.replacesCandidateId
                        ? S.replacement
                        : c.representation === "localCurrentFile"
                          ? S.current
                          : c.representation === "receivedText"
                            ? S.receivedText
                            : c.representation === "receivedBytes"
                              ? S.receivedBytes
                              : S.reference}
                    </small>
                    <p role={row.state === "error" ? "alert" : "status"}>
                      {row.state === "checking"
                        ? S.checking
                        : row.state === "error"
                          ? row.code === "busy"
                            ? S.inspectionBusy
                            : S.errors[row.code ?? "invalidData"]
                          : row.state === "selected"
                            ? `${S.selected} · ${sourceBytes(row.source!)} 字节`
                            : S.omission[
                                row.omission ??
                                  (c.source.kind === "unavailable"
                                    ? c.source.reason
                                    : "notSelected")
                              ]}
                    </p>
                    <div className="ac-actions" style={{ flexWrap: "wrap" }}>
                      {row.state === "error" && (
                        <>
                          <button
                            type="button"
                            className="btn btn-text"
                            onClick={() =>
                              void selection.select(c.candidateId, true)
                            }
                          >
                            {S.retry}
                          </button>
                          <button
                            type="button"
                            className="btn btn-text"
                            onClick={() =>
                              void selection.select(c.candidateId, false)
                            }
                          >
                            {S.exclude}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-text"
                        onClick={() => void replace(c.candidateId)}
                      >
                        {S.chooseReplacement}
                      </button>
                    </div>
                  </div>
                );
              })}
            </fieldset>
            <p>{S.counts(selected.length, rows.length - selected.length)}</p>
            {busy && <p role="status">{S.pending}</p>}
            {cancelled && <p role="status">{S.pickerCancelled}</p>}
            {error && <p role="alert">{S.errors[error]}</p>}
          </>
        )}
        <footer>
          <button type="button" className="btn btn-ghost" onClick={close}>
            {jobId ? S.continue : S.close}
          </button>
          {!jobId && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || blocked}
              onClick={() => void submit()}
            >
              {S.save}
            </button>
          )}
        </footer>
      </div>
    </WorkspaceDialog>
  );
}
