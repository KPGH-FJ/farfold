import { invoke } from "@tauri-apps/api/core";
import { isAbsoluteFilePath } from "./file_paths";
import type { ToolCallView } from "./session_types";

/** A reported path is a candidate, never proof that a file was written. */
export interface ReportedFile {
  path: string;
  toolCallId: string;
  source: "diff" | "location" | "resourceLink";
}

export interface VerifiedFile {
  root: string;
  path: string;
  resolvedPath: string;
  name: string;
  size: number;
  sha256: string;
  version: string;
}

export interface TextPreview {
  file: VerifiedFile;
  text: string;
}

/** A metadata hint is not a fresh content-verification receipt. */
export type FileRevisionCheck =
  { kind: "hintUnchanged" } | { kind: "verified"; file: VerifiedFile };

export type FileRevisionFailureCode =
  | "missing"
  | "redirected"
  | "changing"
  | "notFile"
  | "tooLarge"
  | "unreadable"
  | "pending"
  | "busy"
  | "unavailable";

export interface VisualPreview {
  file: VerifiedFile;
  mimeType: string;
  data: string;
}

export interface DeliveryReceipt {
  kind: "fileCopy" | "textSnapshot";
  destination: string;
  size: number;
  sha256: string;
  sourceVersion: string | null;
}

function plainPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[a-z]:[\\/]/i.test(path))
  );
}

/** Only an explicit local file URI, never a web URL or a path in prose. */
export function localResourcePath(uri: string): string | null {
  if (typeof uri !== "string") return null;
  try {
    const url = new URL(uri);
    if (
      url.protocol !== "file:" ||
      (url.hostname && url.hostname !== "localhost") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const decoded = decodeURIComponent(url.pathname);
    const path = /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded;
    return isAbsoluteFilePath(path) && plainPath(path) ? path : null;
  } catch {
    return null;
  }
}

/** Keep distinct report sources; repeated fields are not additional provenance. */
export function reportedFileSources(call: ToolCallView): ReportedFile[] {
  if (call.status !== "completed" || call.kind === "delete") return [];
  const found = new Map<string, ReportedFile>();
  const add = (path: string, source: ReportedFile["source"]) => {
    const key = JSON.stringify([path, source]);
    if (plainPath(path) && !found.has(key))
      found.set(key, { path, source, toolCallId: call.toolCallId });
  };
  for (const content of call.content) {
    if (content.type === "diff") add(content.path, "diff");
    if (content.type === "link") {
      const path = localResourcePath(content.uri);
      if (path) add(path, "resourceLink");
    }
  }
  // Locations on edit/move are protocol fields. Read/search locations are inputs.
  if (call.kind === "edit" || call.kind === "move")
    for (const location of call.locations) add(location.path, "location");
  return [...found.values()];
}

/** Compatibility for callers asking for one candidate per declared path. */
export function reportedFiles(call: ToolCallView): ReportedFile[] {
  const files = new Map<string, ReportedFile>();
  for (const file of reportedFileSources(call))
    if (!files.has(file.path)) files.set(file.path, file);
  return [...files.values()];
}

function inspectionFailure(error: unknown): never {
  // These two legacy inspection commands return fixed strings. Only their
  // ordinary-file limit means 256 MiB; media/text readers have smaller limits.
  if (error === "文件超过当前操作的大小限制") {
    const failure = new Error(error);
    failure.name = ""; // Preserve String(error) for existing delivery callers.
    throw Object.assign(failure, { code: "tooLarge" });
  }
  throw error;
}

export const fileDelivery = {
  /** One exact file explicitly chosen through the picker or a clicked file link. */
  inspectSelected: (path: string) =>
    invoke<VerifiedFile>("file_delivery_inspect_selected", { path }).catch(
      inspectionFailure,
    ),
  /** Called only after a user clicks this exact local file target. */
  inspectLink: (root: string, path: string) =>
    isAbsoluteFilePath(path)
      ? fileDelivery.inspectSelected(path)
      : fileDelivery.inspect(root, path),
  inspect: (root: string, path: string) =>
    invoke<VerifiedFile>("file_delivery_inspect", { root, path }).catch(
      inspectionFailure,
    ),
  checkRevision: (file: VerifiedFile, mode: "hint" | "content") =>
    invoke<FileRevisionCheck>("file_delivery_check_revision", { file, mode }),
  readText: (file: VerifiedFile) =>
    invoke<TextPreview>("file_delivery_read_text", { file }),
  readVisual: (file: VerifiedFile) =>
    invoke<VisualPreview>("file_delivery_read_visual", { file }),
  exportText: (text: string, destination: string) =>
    invoke<DeliveryReceipt>("file_delivery_export_text", { text, destination }),
  open: (file: VerifiedFile) => invoke<void>("file_delivery_open", { file }),
  reveal: (file: VerifiedFile) =>
    invoke<void>("file_delivery_reveal", { file }),
  /** Explicit failure fallback. This opens a location, never a verified revision. */
  openSelectedLocation: (root: string, path: string) =>
    invoke<void>(
      "file_delivery_open_selected_location",
      isAbsoluteFilePath(path) ? { path } : { path, root },
    ),
  revealSelectedLocation: (root: string, path: string) =>
    invoke<void>(
      "file_delivery_reveal_selected_location",
      isAbsoluteFilePath(path) ? { path } : { path, root },
    ),
  /** Show a recorded working directory in the file manager. */
  revealLocation: (path: string) =>
    invoke<void>("file_delivery_reveal_location", { path }),
};

export interface FileDeliveryTarget {
  threadKey: string;
  root: string;
  path: string;
  toolCallId: string | null;
}

export type FileVerification =
  | { state: "unverified"; target: FileDeliveryTarget }
  | { state: "checking"; target: FileDeliveryTarget }
  | { state: "verified"; target: FileDeliveryTarget; file: VerifiedFile }
  | { state: "failed"; target: FileDeliveryTarget; error: string };

/** Local view state only; no file body, history or authority is persisted. */
export class FileVerificationSelection {
  current: FileVerification | null = null;

  select(target: FileDeliveryTarget): void {
    this.current = { state: "unverified", target: { ...target } };
  }

  clear(): void {
    this.current = null;
  }

  async verify(
    inspect: typeof fileDelivery.inspect = fileDelivery.inspect,
  ): Promise<void> {
    if (!this.current) return;
    const pending: FileVerification = {
      state: "checking",
      target: this.current.target,
    };
    this.current = pending;
    try {
      const file = await inspect(pending.target.root, pending.target.path);
      if (this.current === pending)
        this.current = { state: "verified", target: pending.target, file };
    } catch (error) {
      if (this.current === pending)
        this.current = {
          state: "failed",
          target: pending.target,
          error: String(error),
        };
    }
  }
}
