import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { STORAGE_RESTORE_STRINGS as S } from "../runtime/storage_restore_strings";
import {
  previewEntries,
  checkedPreview,
  checkedReceipt,
  restoreFailure,
  type RestoreKey,
  type RestorePreview,
  type RestoreReceipt,
} from "../runtime/storage_restore";

/** Only mounted while DraftStartup has failed and no editor has been admitted. */
export function StorageRestore({
  keys,
  disabled,
  onBlockChange,
}: {
  keys: readonly RestoreKey[];
  disabled: boolean;
  onBlockChange: (value: boolean) => void;
}) {
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [selected, setSelected] = useState<RestoreKey[]>([]);
  const [receipt, setReceipt] = useState<RestoreReceipt | null>(null);
  const [busy, setBusy] = useState<
    "preview" | "apply" | "check" | "cancel" | null
  >(null);
  const [failure, setFailure] = useState<ReturnType<
    typeof restoreFailure
  > | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false);
  const run = async (action: NonNullable<typeof busy>) => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(action);
    setFailure(null);
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
        setPreview(null);
        setSelected([]);
        setReceipt(null);
        const value = checkedPreview(
          await invoke<RestorePreview>("storage_recovery_restore_preview", {
            source,
          }),
        );
        // Complete semantic parsing occurs here before any confirmation is enabled.
        previewEntries(value, keys);
        setPreview(value);
        setUncertain(false);
      } else if (action === "cancel") {
        await invoke("storage_recovery_restore_cancel");
        setPreview(null);
        setSelected([]);
        setUncertain(false);
        onBlockChange(false);
      } else if (action === "check") {
        if (!preview) return;
        const result = await invoke<RestoreReceipt | null>(
          "storage_recovery_restore_receipt",
          { id: preview.id },
        );
        if (result) {
          setReceipt(checkedReceipt(result, preview.id, selected));
          setUncertain(false);
        } else
          setFailure({
            known: false,
            message: S.noReceipt,
            materialsPath: null,
            complete: false,
          });
      } else {
        if (!preview || uncertain || !selected.length) return;
        const entries = previewEntries(preview, keys);
        if (
          selected.some(
            (key) => !entries.find((entry) => entry.key === key && entry.valid),
          )
        )
          return;
        const backupDirectory = await open({
          directory: true,
          multiple: false,
          title: S.chooseBackup,
        });
        if (typeof backupDirectory !== "string") return;
        try {
          const result = await invoke<RestoreReceipt>(
            "storage_recovery_restore_apply",
            { id: preview.id, keys: selected, backupDirectory },
          );
          setReceipt(checkedReceipt(result, preview.id, selected));
        } catch (reason) {
          const error = restoreFailure(reason);
          setFailure(error);
          if (!error.known) setUncertain(true);
        }
      }
    } catch (reason) {
      setFailure(restoreFailure(reason));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  const entries = preview ? previewEntries(preview, keys) : [];
  return (
    <section
      className="storage-restore"
      aria-busy={busy !== null}
      aria-label={S.title}
    >
      {!preview && !receipt && (
        <button
          type="button"
          className="btn"
          disabled={disabled || busy !== null}
          onClick={() => void run("preview")}
        >
          {busy === "preview" ? S.loading : S.choose}
        </button>
      )}
      {preview && !receipt && (
        <>
          <h2>{S.title}</h2>
          <p>{S.note}</p>
          <code>{preview.sourcePath}</code>
          <p className="storage-recovery-note">{S.captured}</p>
          <fieldset disabled={busy !== null || uncertain}>
            {entries.map((entry) => (
              <label key={entry.key} className="storage-restore-choice">
                <input
                  type="checkbox"
                  disabled={!entry.valid}
                  checked={selected.includes(entry.key)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, entry.key]
                        : previous.filter((key) => key !== entry.key),
                    )
                  }
                />
                <span>
                  <strong>{entry.label}</strong>
                  <span>{entry.summary}</span>
                  {entry.empty && <span>{S.empty}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="storage-recovery-actions">
            {!uncertain && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || !selected.length}
                onClick={() => void run("apply")}
              >
                {busy === "apply" ? S.applying : S.confirm}
              </button>
            )}
            {uncertain && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() => void run("check")}
              >
                {S.check}
              </button>
            )}
            {!uncertain && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void run("cancel")}
              >
                {S.cancel}
              </button>
            )}
          </div>
        </>
      )}
      {receipt && (
        <div role="status" className="storage-recovery-receipt">
          <p>{S.restored}</p>
          <code>{receipt.protectedPath}</code>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            {S.reloading}
          </button>
        </div>
      )}
      {failure && (
        <div role="alert">
          <p>{failure.message}</p>
          {failure.materialsPath && (
            <>
              <p>{failure.complete ? S.materials : S.partialMaterials}</p>
              <code>{failure.materialsPath}</code>
            </>
          )}
          {!preview && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void run("cancel")}
            >
              {S.cancel}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
