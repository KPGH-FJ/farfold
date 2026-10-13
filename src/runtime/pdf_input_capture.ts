import { invoke } from "@tauri-apps/api/core";
import type { VerifiedFile } from "./file_delivery";
import { isAbsoluteFilePath } from "./file_paths";
import {
  PDF_INPUT_LIMITS as L,
  PdfInputError,
  type PdfInputCapture,
  type PdfInputFailure,
} from "./pdf_input_types";

const keys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
] as const;
export function checkedPdfInputFile(value: unknown): VerifiedFile {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new PdfInputError("invalid");
  const file = value as VerifiedFile;
  for (const k of ["root", "path", "resolvedPath", "name", "version"] as const)
    if (
      typeof file[k] !== "string" ||
      !file[k].length ||
      file[k].length > 32768 ||
      /[\0-\x1f\x7f]/.test(file[k])
    )
      throw new PdfInputError("invalid");
  if (
    ![file.root, file.path, file.resolvedPath].every(isAbsoluteFilePath) ||
    typeof file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new PdfInputError("invalid");
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 5 ||
    file.size > L.sourceBytes
  )
    throw new PdfInputError("limit");
  return { ...file };
}
/** Whole bytes, strict base64, seven-field identity and actual SHA, not a prefix. */
export async function decodePdfInputCapture(
  expected: VerifiedFile,
  value: unknown,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw new PdfInputError("cancelled");
  const file = checkedPdfInputFile(expected);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("file" in value) ||
    !("data" in value)
  )
    throw new PdfInputError("invalid");
  const capture = value as PdfInputCapture;
  const actual = checkedPdfInputFile(capture.file);
  if (keys.some((k) => file[k] !== actual[k]))
    throw new PdfInputError("changed");
  if (
    typeof capture.data !== "string" ||
    capture.data.length > Math.ceil(L.sourceBytes / 3) * 4
  )
    throw new PdfInputError("limit");
  if (
    capture.data.length !== Math.ceil(file.size / 3) * 4 ||
    /[^A-Za-z0-9+/=]/.test(capture.data) ||
    capture.data.slice(0, -2).includes("=") ||
    (capture.data.at(-2) === "=" && capture.data.at(-1) !== "=")
  )
    throw new PdfInputError("invalid");
  let raw: string;
  try {
    raw = atob(capture.data);
  } catch {
    throw new PdfInputError("invalid");
  }
  if (
    raw.length !== file.size ||
    btoa(raw) !== capture.data ||
    raw.slice(0, 5) !== "%PDF-"
  )
    throw new PdfInputError("invalid");
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  if (signal.aborted) throw new PdfInputError("cancelled");
  const sha = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (sha !== file.sha256) throw new PdfInputError("changed");
  return bytes;
}

/** Cancels the UI wait only. The native OS operation retains its real read slot. */
export async function readPdfInputCapture(
  file: VerifiedFile,
  signal: AbortSignal,
): Promise<PdfInputCapture> {
  if (signal.aborted) throw new PdfInputError("cancelled");
  const expected = checkedPdfInputFile(file);
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        const capture = await invoke<PdfInputCapture>(
          "file_delivery_read_pdf_input",
          { file: expected },
        );
        await decodePdfInputCapture(expected, capture, signal);
        return { file: { ...expected }, data: capture.data };
      })(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new PdfInputError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    const codes: readonly PdfInputFailure[] = [
      "changed",
      "unreadable",
      "invalid",
      "limit",
      "readPending",
      "readBusy",
    ];
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    throw new PdfInputError(
      typeof code === "string" && codes.includes(code as PdfInputFailure)
        ? (code as PdfInputFailure)
        : "unreadable",
    );
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
