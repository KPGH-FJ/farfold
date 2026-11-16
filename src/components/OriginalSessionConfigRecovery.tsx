import { open } from "@tauri-apps/plugin-dialog";
import { useRef, useState, type RefObject } from "react";
import { sameConfigurationSnapshot } from "../runtime/config_check";
import {
  originalSessionConfigBusy,
  originalSessionConfigTarget,
  reviewOriginalSessionConfig,
  type OriginalConfigReview,
} from "../runtime/original_session_config";
import { threads, type ThreadState } from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { useContentOwner } from "./useContentOwner";
import { WorkspaceDialog } from "./WorkspaceDialog";

const S = STRINGS.repair.originalConversation;

export function useOriginalSessionConfigRecovery(
  thread: ThreadState,
  enabled: boolean,
) {
  const ownsContent = useContentOwner(thread, enabled);
  const opener = useRef<HTMLButtonElement>(null);
  const [review, setReview] = useState<(() => boolean) | null>(null);
  const target = enabled ? originalSessionConfigTarget(thread) : null;
  return {
    action: target && (
      <button
        ref={opener}
        type="button"
        className="btn btn-ghost"
        disabled={originalSessionConfigBusy(thread)}
        onClick={() => {
          if (ownsContent())
            setReview(
              () => () =>
                ownsContent() && thread.connectionId === target.connectionId,
            );
        }}
      >
        {S.title}
      </button>
    ),
    dialog: target && review?.() && (
      <OriginalSessionConfigRecovery
        thread={thread}
        ownsView={review}
        opener={opener}
        onClose={() =>
          setReview((current) => (current === review ? null : current))
        }
      />
    ),
  };
}

function OriginalSessionConfigRecovery({
  thread,
  ownsView,
  opener,
  onClose,
}: {
  thread: ThreadState;
  ownsView: () => boolean;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<{
    review: OriginalConfigReview;
    check: ThreadState["configCheck"];
  } | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const blocked = originalSessionConfigBusy(thread);
  const previewMatches =
    preview && sameConfigurationSnapshot(preview.check, thread.configCheck);
  const read = async (backup: boolean) => {
    if (pending.current || blocked || !ownsView()) return;
    pending.current = true;
    setBusy("reading");
    setError(null);
    setPreview(null);
    setChecked(false);
    try {
      const file = backup
        ? await open({
            multiple: false,
            directory: false,
            title: S.chooseBackup,
            filters: [
              { name: S.backupType, extensions: ["sqlite3", "sqlite", "db"] },
            ],
          })
        : undefined;
      if (!ownsView() || (backup && typeof file !== "string")) return;
      const review = await reviewOriginalSessionConfig(
        thread,
        ownsView,
        typeof file === "string" ? file : undefined,
      );
      if (!ownsView()) return;
      if (review) {
        setPreview({ review, check: structuredClone(thread.configCheck) });
      } else {
        setError(backup ? S.backupFailed : S.readFailed);
      }
    } catch {
      if (ownsView()) setError(backup ? S.backupFailed : S.readFailed);
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  const save = async () => {
    if (
      pending.current ||
      blocked ||
      !ownsView() ||
      !previewMatches ||
      !preview ||
      !checked
    )
      return;
    pending.current = true;
    setBusy("saving");
    setError(null);
    try {
      const confirmed = await threads.confirmOriginalConfig(
        thread.key,
        preview.review.reviewId,
      );
      if (!ownsView()) return;
      if (confirmed) {
        onClose();
      } else {
        setPreview(null);
        setChecked(false);
        setError(S.saveFailed);
      }
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  return (
    <WorkspaceDialog
      title={S.title}
      onClose={onClose}
      returnFocusRef={opener}
      returnFocusWhen={ownsView}
      busy={busy !== null}
    >
      <div className="workspace-dialog-body">
        <p>{S.introduction}</p>
        {busy === "reading" && <p role="status">{S.reading}</p>}
        {previewMatches && preview && (
          <>
            <p>
              {preview.review.source === "backup"
                ? S.backupNote
                : S.currentNote}
            </p>
            <dl className="config-guard-choices">
              <div>
                <dt>{S.source}</dt>
                <dd>{S.existing}</dd>
              </div>
              {preview.review.choices.map(({ id, name, label }) => (
                <div key={id}>
                  <dt>{name}</dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
            <label className="original-conversation-confirmation">
              <input
                type="checkbox"
                checked={checked}
                disabled={busy !== null || blocked}
                onChange={(event) => setChecked(event.currentTarget.checked)}
              />
              {S.attestation}
            </label>
            <p>{S.sendNote}</p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy !== null}
          onClick={onClose}
        >
          {S.cancel}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy !== null || blocked}
          onClick={() => void read(true)}
        >
          {S.readBackup}
        </button>
        {previewMatches ? (
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy !== null || blocked || !checked}
            onClick={() => void save()}
          >
            {busy === "saving" ? S.saving : S.apply}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy !== null || blocked}
            onClick={() => void read(false)}
          >
            {S.readCurrent}
          </button>
        )}
      </footer>
    </WorkspaceDialog>
  );
}
