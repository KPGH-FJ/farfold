import { useCallback, useEffect, useState } from "react";
import {
  managedUpdateCheck,
  managedUpdateInstall,
  managedUpdateSnapshot,
  type ManagedUpdateSnapshot,
} from "../runtime/managed-update";
import { STRINGS } from "../runtime/strings";

interface UpdateDialogProps {
  onClose: () => void;
}

export function UpdateDialog({ onClose }: UpdateDialogProps) {
  const [snapshot, setSnapshot] = useState<ManagedUpdateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setSnapshot(await managedUpdateSnapshot());
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const check = async () => {
    setError(null);
    try {
      setSnapshot(await managedUpdateCheck());
    } catch (reason) {
      setError(String(reason));
      setSnapshot(await managedUpdateSnapshot().catch(() => snapshot));
    }
  };

  const install = async () => {
    const token = snapshot?.candidate?.candidateToken;
    if (!token) return;
    setError(null);
    try {
      await managedUpdateInstall(token);
      // The app restarts on success; reaching here is unexpected but harmless.
    } catch (reason) {
      setError(String(reason));
    }
  };

  const busy = !snapshot || snapshot.checking || snapshot.installing;
  const candidate = snapshot?.candidate ?? null;

  return (
    <div
      className="update-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={STRINGS.update.title}
      >
        <div className="update-head">
          <div className="update-title">{STRINGS.update.title}</div>
          <button type="button" className="btn btn-text" onClick={onClose}>
            {STRINGS.update.close}
          </button>
        </div>

        <div className="gen-row">
          <div>{STRINGS.update.currentVersion}</div>
          <span className="gv">{snapshot?.currentVersion ?? "…"}</span>
        </div>

        {snapshot?.blockers.includes("release_infrastructure_unconfigured") && (
          <div className="ac-error" role="status">
            {STRINGS.update.unconfigured}
          </div>
        )}
        {snapshot?.blockers.includes("release_infrastructure_invalid") && (
          <div className="ac-error" role="alert">
            {STRINGS.update.invalidConfig}
          </div>
        )}

        {candidate ? (
          <div className="update-candidate">
            <div className="update-candidate-version">
              {STRINGS.update.candidate(candidate.version)}
            </div>
            {candidate.notes && (
              <div className="update-notes">{candidate.notes}</div>
            )}
            <div className="update-hint">{STRINGS.update.installHint}</div>
            <div className="ac-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void install()}
              >
                {snapshot?.installing
                  ? STRINGS.update.installing
                  : STRINGS.update.installAndRestart}
              </button>
            </div>
          </div>
        ) : (
          <div className="ac-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void check()}
            >
              {snapshot?.checking
                ? STRINGS.update.checking
                : STRINGS.update.check}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {STRINGS.update.refresh}
            </button>
            {snapshot && !snapshot.checking && !candidate && (
              <span className="update-uptodate">{STRINGS.update.upToDate}</span>
            )}
          </div>
        )}

        {error && (
          <div className="ac-error" role="alert">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
