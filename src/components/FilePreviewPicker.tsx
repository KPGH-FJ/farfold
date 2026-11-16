import { useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { fileDelivery, type VerifiedFile } from "../runtime/file_delivery";
import { isAbsoluteFilePath } from "../runtime/file_paths";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import { FILE_PREVIEW_PICKER_STRINGS as S } from "../runtime/file_preview_picker_strings";

type Phase = "choosing" | "checking";
// A system dialog outlives its view. Retain its admission until the original
// promise settles, including across unmounts and different retained threads.
let pending: { phase: Phase } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());

function selectedReceipt(value: unknown, selected: string): VerifiedFile {
  const file = value as VerifiedFile | null;
  if (
    !file ||
    typeof file !== "object" ||
    Array.isArray(file) ||
    !["root", "path", "resolvedPath"].every((key) => {
      const path = file[key as "root" | "path" | "resolvedPath"];
      return typeof path === "string" && isAbsoluteFilePath(path);
    }) ||
    file.path !== selected ||
    typeof file.name !== "string" ||
    !file.name.length ||
    /[\u0000-\u001f\u007f/]/.test(file.name) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.version !== "string" ||
    !file.version.trim() ||
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(file.sha256)
  )
    throw new Error("Invalid selected-file receipt");
  return file;
}

function failureNotice(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  if (message === D.checkWaitExpired || message === D.checkBusy) return message;
  return error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "tooLarge"
    ? S.tooLarge
    : S.failed;
}

/** Explicit single-file selection only; no content, history or reusable grant. */
export function FilePreviewPicker({
  workingDirectory,
  active,
  isCurrent,
  onOpenFile,
}: {
  workingDirectory: string;
  active: boolean;
  /** Captured navigation owner; returning to an earlier view cannot revive it. */
  isCurrent: () => boolean;
  onOpenFile: (file: VerifiedFile) => void;
}) {
  const latest = useRef({ workingDirectory, active, isCurrent, onOpenFile });
  latest.current = { workingDirectory, active, isCurrent, onOpenFile };
  const lifetime = useRef<object | null>({});
  const [phase, setPhase] = useState<Phase | null>(pending?.phase ?? null);
  const [error, setError] = useState<{
    message: string;
    current: () => boolean;
  } | null>(null);
  useLayoutEffect(() => {
    const token = {};
    lifetime.current = token;
    const update = () => setPhase(pending?.phase ?? null);
    listeners.add(update);
    update();
    return () => {
      if (lifetime.current === token) lifetime.current = null;
      listeners.delete(update);
    };
  }, []);

  const choose = async () => {
    if (pending || !lifetime.current || !active || !isCurrent()) return;
    const mount = lifetime.current;
    const owner = isCurrent;
    const operation = { phase: "choosing" as Phase };
    const current = () =>
      pending === operation &&
      lifetime.current === mount &&
      latest.current.active &&
      latest.current.workingDirectory === workingDirectory &&
      owner();
    pending = operation;
    publish();
    setError(null);
    try {
      const selected = await open({
        title: S.title,
        multiple: false,
        directory: false,
        ...(workingDirectory.trim() ? { defaultPath: workingDirectory } : {}),
      });
      if (!current() || selected === null) return;
      if (typeof selected !== "string" || !isAbsoluteFilePath(selected))
        throw new Error("Invalid single-file selection");
      operation.phase = "checking";
      publish();
      const file = selectedReceipt(
        await fileDelivery.inspectSelected(selected),
        selected,
      );
      if (current()) onOpenFile(file);
    } catch (cause) {
      if (current())
        setError({
          message: failureNotice(cause),
          current: () => lifetime.current === mount && owner(),
        });
    } finally {
      if (pending === operation) {
        pending = null;
        publish();
      }
    }
  };

  return (
    <section aria-label={S.label}>
      <div
        className="file-preview-picker-actions"
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          minWidth: 0,
          padding: "4px 14px 9px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!active || phase !== null || !isCurrent()}
          onClick={() => void choose()}
        >
          {S.open}
        </button>
        {phase && <span role="status">{S[phase]}</span>}
      </div>
      {active && error?.current() && (
        <p className="a-note" role="alert">
          {error.message}
        </p>
      )}
    </section>
  );
}
