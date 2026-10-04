import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { FileArtifact } from "../runtime/artifact_view";
import {
  fileDelivery,
  type TextPreview,
  type VerifiedFile,
} from "../runtime/file_delivery";
import { FILE_DELIVERY_STRINGS as S } from "../runtime/file_delivery_strings";

export interface FileDeliveryActionsProps {
  card: FileArtifact;
  workingDirectory: string;
  active?: boolean;
  /** Changes with the original thread, reported revision, path and status. */
  identity: string;
}

/** Arguments to write/edit tools are not evidence of a reported output file. */
export function reportedArtifactPath(card: FileArtifact): string | null {
  return card.source === "diff" &&
    card.status === "completed" &&
    card.path.trim()
    ? card.path
    : null;
}

/** The keyed scope also invalidates a dialog that finishes after switching files. */
export function FileDeliveryActions(props: FileDeliveryActionsProps) {
  return <FileDeliveryControls key={props.identity} {...props} />;
}

export function FileDeliveryControls({
  card,
  workingDirectory,
  active = true,
}: FileDeliveryActionsProps) {
  const candidate = reportedArtifactPath(card);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<VerifiedFile | null>(null);
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const sequence = useRef(0);
  const busy = useRef<number | null>(null);
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      busy.current = null;
    };
  }, []);
  useEffect(() => {
    // Hide/deactivate does not unmount the retained conversation. Invalidate
    // its pending dialog even if the user returns before that dialog finishes.
    // Keep busy until the original action settles: a submitted backend action
    // has not been cancelled just because this page is no longer active.
    if (!active) sequence.current += 1;
  }, [active]);

  const current = (token: number) =>
    mounted.current &&
    activeRef.current &&
    sequence.current === token &&
    busy.current === token;

  const run = async (
    label: string,
    action: (token: number) => Promise<void>,
  ) => {
    // The ref closes the interval before React publishes the disabled buttons.
    if (busy.current !== null || !mounted.current || !activeRef.current) return;
    const token = ++sequence.current;
    busy.current = token;
    setPending(label);
    setError(null);
    setResult(null);
    try {
      await action(token);
    } catch (cause) {
      if (mounted.current && busy.current === token) {
        // Includes changed/missing files: a previous receipt cannot authorize
        // another open, copy or read after an operation reports failure.
        setFile(null);
        setPreview(null);
        if (current(token)) setError(`${S.failed} ${String(cause)}`);
      }
    } finally {
      if (mounted.current && busy.current === token) {
        busy.current = null;
        setPending(null);
      }
    }
  };

  const verify = () =>
    run(S.checking, async (token) => {
      setFile(null);
      setPreview(null);
      const path = selected ?? candidate;
      if (!path || !workingDirectory.trim()) throw new Error(S.missingRoot);
      const next = selected
        ? await fileDelivery.inspectSelected(path)
        : await fileDelivery.inspect(workingDirectory, path);
      if (current(token)) setFile(next);
    });

  const choose = () =>
    run(S.choosePending, async (token) => {
      const path = await open({
        title: S.chooseTitle,
        multiple: false,
        directory: false,
        defaultPath: workingDirectory,
      });
      // No inspect after cancellation, a changed selection or an unmounted view.
      if (!current(token) || typeof path !== "string") return;
      setSelected(path);
      setFile(null);
      setPreview(null);
      const next = await fileDelivery.inspectSelected(path);
      if (current(token)) setFile(next);
    });

  const actOnFile = (
    action: (value: VerifiedFile) => Promise<unknown>,
    message: string,
  ) => {
    if (!file) return;
    const value = file;
    return run(S.deliveryPending, async (token) => {
      await action(value);
      if (current(token)) setResult(message);
    });
  };

  const copy = () => {
    if (!file) return;
    const value = file;
    return run(S.deliveryPending, async (token) => {
      const destination = await save({
        title: S.saveTitle,
        defaultPath: value.name,
      });
      if (!current(token) || !destination) return;
      const receipt = await fileDelivery.copy(value, destination);
      if (current(token)) setResult(S.copied(receipt.destination));
    });
  };

  const exportText = () =>
    run(S.deliveryPending, async (token) => {
      const text = card.newText;
      const destination = await save({
        title: S.snapshotTitle,
        defaultPath: S.snapshotName,
      });
      if (!current(token) || !destination) return;
      const receipt = await fileDelivery.exportText(text, destination);
      if (current(token)) setResult(S.exported(receipt.destination));
    });

  const read = () => {
    if (!file) return;
    const value = file;
    return run(S.readPending, async (token) => {
      const next = await fileDelivery.readText(value);
      if (!current(token)) return;
      // A read receipt must describe the exact version that the user confirmed.
      if (
        next.file.version !== value.version ||
        next.file.resolvedPath !== value.resolvedPath ||
        next.file.sha256 !== value.sha256
      )
        throw new Error(S.failed);
      setPreview(next);
    });
  };

  const disabled = !active || pending !== null;
  return (
    <section className="artifact-provenance" aria-label={S.label}>
      <span>
        {file
          ? S.verified(file.name, file.size)
          : selected
            ? S.selectedCandidate
            : candidate
              ? S.candidate
              : S.noCandidate}
      </span>
      {file && (
        <details>
          <summary>{S.location}</summary>
          <p style={{ overflowWrap: "anywhere" }}>{file.resolvedPath}</p>
          <p>{selected ? S.selectedOrigin : S.reportedOrigin}</p>
        </details>
      )}
      <div className="ac-actions" style={{ flexWrap: "wrap" }}>
        {(candidate || selected) && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !workingDirectory.trim()}
            onClick={() => void verify()}
          >
            {file ? S.inspectAgain : S.inspect}
          </button>
        )}
        {file && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => void actOnFile(fileDelivery.open, S.opened)}
            >
              {S.open}
            </button>
            <button
              type="button"
              className="btn btn-text"
              disabled={disabled}
              onClick={() => void actOnFile(fileDelivery.reveal, S.revealed)}
            >
              {S.reveal}
            </button>
            <button
              type="button"
              className="btn btn-text"
              disabled={disabled}
              onClick={() => void copy()}
            >
              {S.save}
            </button>
            <button
              type="button"
              className="btn btn-text"
              disabled={disabled}
              onClick={() => void read()}
            >
              {S.current}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-text"
          disabled={disabled}
          onClick={() => void choose()}
        >
          {S.choose}
        </button>
        <button
          type="button"
          className="btn btn-text"
          disabled={disabled}
          title={S.snapshotNote}
          onClick={() => void exportText()}
        >
          {S.snapshot}
        </button>
      </div>
      {pending && <span role="status">{pending}</span>}
      {error && (
        <span role="alert" className="failed">
          {error}
        </span>
      )}
      {result && (
        <span role="status" style={{ overflowWrap: "anywhere" }}>
          {result}
        </span>
      )}
      {preview && (
        <details open>
          <summary>{S.currentTitle}</summary>
          <p>{S.currentNote}</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 240,
              overflow: "auto",
              color: "var(--ink)",
              fontSize: 11,
            }}
          >
            {preview.text}
          </pre>
        </details>
      )}
    </section>
  );
}
