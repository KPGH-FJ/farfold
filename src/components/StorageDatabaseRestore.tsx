import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DATABASE_RESTORE as S,
  checkedDatabasePreview,
  checkedDatabaseStatus,
  databaseFailure,
  initialDatabaseStatus,
  type DatabasePreview,
  type DatabaseStatus,
} from "../runtime/storage_database_restore";

export function StorageDatabaseRestore({
  initialStatus,
  disabled,
  onBlockChange,
}: {
  initialStatus?: DatabaseStatus | null;
  disabled: boolean;
  onBlockChange: (value: boolean) => void;
}) {
  const [preview, setPreview] = useState<DatabasePreview | null>(null);
  const [status, setStatus] = useState<DatabaseStatus | null>(
    initialDatabaseStatus(initialStatus),
  );
  const [priorStatus, setPriorStatus] = useState<DatabaseStatus | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [canCancel, setCanCancel] = useState(true);
  const [failure, setFailure] = useState<ReturnType<
    typeof databaseFailure
  > | null>(null);
  const pending = useRef(false);
  const run = async (
    action: "preview" | "cancel" | "apply" | "check" | "continue" | "restart",
  ) => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(action);
    setFailure(null);
    let restarting = false;
    try {
      if (action === "preview") {
        const source = await open({
          multiple: false,
          directory: false,
          title: S.chooseTitle,
          filters: [
            { name: S.fileType, extensions: ["sqlite3", "sqlite", "db"] },
          ],
        });
        if (typeof source !== "string") return;
        onBlockChange(true);
        try {
          setPreview(
            checkedDatabasePreview(
              await invoke("storage_recovery_database_preview", { source }),
            ),
          );
          setPriorStatus(status);
          setStatus(null);
          setConfirmed(false);
        } catch (reason) {
          onBlockChange(status !== null);
          throw reason;
        }
      } else if (action === "cancel") {
        if (!canCancel || status) return;
        await invoke("storage_recovery_database_cancel");
        setPreview(null);
        setStatus(priorStatus);
        setConfirmed(false);
        setUncertain(false);
        setCanCancel(true);
        onBlockChange(priorStatus !== null);
      } else if (action === "check") {
        const result = await invoke("storage_recovery_database_status");
        const checked = result === null ? null : checkedDatabaseStatus(result);
        if (checked === null || (checked.phase === "released" && !status)) {
          setCanCancel(true);
          setFailure({
            message: S.noReceipt,
            materialsPath: failure?.materialsPath ?? null,
          });
        } else if (
          checked.phase === "preparing" &&
          checked.id === priorStatus?.id &&
          priorStatus.phase === "preparing" &&
          !status
        ) {
          // Only the exact known earlier preparation can regain reselection.
          setPreview(null);
          setStatus(checked);
          setUncertain(false);
          setCanCancel(false);
        } else {
          setStatus(checkedDatabaseStatus(checked, status?.id ?? preview?.id));
          setUncertain(false);
          setCanCancel(false);
        }
      } else if (action === "restart") {
        if (!status?.canRestart || !status.id || uncertain) return;
        await invoke("storage_recovery_database_restart", { id: status.id });
        setBusy("restarting");
        restarting = true;
        return;
      } else {
        const id = action === "apply" ? preview?.id : status?.id;
        if (
          !id ||
          uncertain ||
          (action === "apply" && !confirmed) ||
          (action === "continue" && !status?.canContinue)
        )
          return;
        setUncertain(true);
        setCanCancel(false);
        onBlockChange(true);
        const result = await invoke(
          action === "apply"
            ? "storage_recovery_database_apply"
            : "storage_recovery_database_continue",
          { id },
        );
        setStatus(checkedDatabaseStatus(result, id));
        setUncertain(false);
      }
    } catch (reason) {
      setFailure(databaseFailure(reason));
      if (action === "apply" || action === "continue" || action === "restart")
        setUncertain(true);
    } finally {
      pending.current = restarting;
      setBusy((value) => (value === "restarting" ? value : null));
    }
  };
  const waiting = busy !== null || disabled;
  return (
    <section
      className="storage-restore"
      aria-label={S.title}
      aria-busy={waiting}
    >
      {!uncertain &&
        ((!preview && !status) || status?.phase === "preparing") && (
          <button
            type="button"
            className="btn"
            disabled={disabled || waiting}
            onClick={() => void run("preview")}
          >
            {busy === "preview" ? S.checking : S.choose}
          </button>
        )}
      {preview && !status && (
        <>
          <h2>{S.title}</h2>
          <p>{S.scope}</p>
          <p>
            {S.counts(
              preview.counts.agents,
              preview.counts.sessions,
              preview.counts.settings,
            )}
          </p>
          <code>{preview.sourcePath}</code>
          <p className="storage-recovery-note">{S.captured}</p>
          <p className="storage-recovery-note">{S.boundary}</p>
          {!uncertain && (
            <label className="storage-restore-choice">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={waiting}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{S.confirmChoice}</span>
            </label>
          )}
        </>
      )}
      {status && (
        <div role="status">
          <h2>{S.title}</h2>
          <p>
            {status.phase === "installed"
              ? S.installed
              : status.phase === "pending"
                ? S.pending
                : status.phase === "preparing"
                  ? S.preparing
                  : S.blocked}
          </p>
        </div>
      )}
      {(preview || status || uncertain) && (
        <div className="storage-recovery-actions">
          {preview && !status && !uncertain && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={waiting || !confirmed}
              onClick={() => void run("apply")}
            >
              {busy === "apply" ? S.applying : S.confirm}
            </button>
          )}
          {status?.canContinue && !uncertain && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={waiting}
              onClick={() => void run("continue")}
            >
              {busy === "continue" ? S.applying : S.continue}
            </button>
          )}
          {status?.canRestart && !uncertain && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={waiting}
              onClick={() => void run("restart")}
            >
              {busy === "restarting" ? S.restarting : S.restart}
            </button>
          )}
          {(uncertain || status?.phase === "blocked") && (
            <button
              type="button"
              className="btn"
              disabled={waiting}
              onClick={() => void run("check")}
            >
              {S.check}
            </button>
          )}
          {preview && !status && canCancel && (
            <button
              type="button"
              className="btn"
              disabled={waiting}
              onClick={() => void run("cancel")}
            >
              {S.cancel}
            </button>
          )}
        </div>
      )}
      {(status?.protectedPath || status?.retainedPath) && (
        <div className="storage-recovery-receipt">
          {status.protectedPath && (
            <>
              <p>{S.protected}</p>
              <code>{status.protectedPath}</code>
            </>
          )}
          {status.retainedPath && (
            <>
              <p>{status.phase === "preparing" ? S.partial : S.retained}</p>
              <code>{status.retainedPath}</code>
            </>
          )}
        </div>
      )}
      {failure && (
        <div role="alert">
          <p>{failure.message}</p>
          {failure.materialsPath && (
            <>
              <p>{S.partial}</p>
              <code>{failure.materialsPath}</code>
            </>
          )}
        </div>
      )}
    </section>
  );
}
