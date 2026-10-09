import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { STRINGS } from "../runtime/strings";
import {
  storageFailureMessage,
  storageExportFailure,
  storageIssueMessage,
  type StorageExportReceipt,
  type StorageRecoveryStatus,
} from "../runtime/storage_recovery";
import "./StorageRecovery.css";

const S = STRINGS.storageRecovery;

/** This page has no data reset action and does not mount editable surfaces. */
export function StorageRecovery({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"retry" | "export" | "reveal" | null>(null);
  const actionPending = useRef(false);
  const [partialPath, setPartialPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StorageExportReceipt | null>(null);
  const run = async (action: "retry" | "export" | "reveal") => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(action);
    setError(null);
    try {
      if (action === "retry") await onRetry();
      else if (action === "reveal") await invoke("storage_recovery_reveal");
      else {
        setReceipt(null);
        setPartialPath(null);
        const directory = await open({
          directory: true,
          multiple: false,
          title: S.chooseFolder,
        });
        if (typeof directory !== "string") return;
        const saved = await invoke<StorageExportReceipt>(
          "storage_recovery_export",
          { directory },
        );
        setReceipt(saved);
      }
    } catch (reason) {
      if (action === "export") {
        const failure = storageExportFailure(reason);
        setError(failure.message);
        setPartialPath(failure.partialPath);
      } else
        setError(
          storageFailureMessage(
            reason,
            action === "reveal" ? S.revealFailed : S.issues.unknown,
          ),
        );
    } finally {
      actionPending.current = false;
      setBusy(null);
    }
  };
  return (
    <main className="storage-recovery" aria-busy={busy !== null}>
      <section
        className="storage-recovery-card"
        aria-labelledby="storage-recovery-title"
      >
        <span className="storage-recovery-brand">Farfold</span>
        <h1 id="storage-recovery-title">{S.title}</h1>
        <p role="alert">{message}</p>
        <p className="storage-recovery-note">{S.preserved}</p>
        <div className="storage-recovery-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => void run("retry")}
          >
            {busy === "retry" ? S.checking : S.retry}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void run("export")}
          >
            {busy === "export" ? S.exporting : S.export}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void run("reveal")}
          >
            {S.reveal}
          </button>
        </div>
        <p className="storage-recovery-note">{S.privacy}</p>
        {receipt && (
          <div className="storage-recovery-receipt" role="status">
            <p>
              {receipt.kind === "snapshot" ? S.snapshotSaved : S.filesSaved}
            </p>
            <code>{receipt.path}</code>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {partialPath && (
          <div className="storage-recovery-receipt" role="status">
            <p>{S.partialSaved}</p>
            <code>{partialPath}</code>
          </div>
        )}
      </section>
    </main>
  );
}

export function StorageStartup({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StorageRecoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void invoke<StorageRecoveryStatus>("storage_recovery_status").then(
      (value) => {
        if (active) setStatus(value);
      },
      () => {
        if (active) setError(S.issues.unknown);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (status?.ready === true) return children;
  if (!status && !error)
    return (
      <main className="storage-recovery">
        <p role="status">{S.loading}</p>
      </main>
    );
  return (
    <StorageRecovery
      message={error ?? storageIssueMessage(status?.issue?.kind ?? "unknown")}
      onRetry={async () => {
        const next = await invoke<StorageRecoveryStatus>(
          "storage_recovery_retry",
        );
        setStatus(next);
        setError(null);
      }}
    />
  );
}
