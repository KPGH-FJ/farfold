import {
  fileDelivery,
  localResourcePath,
  type VerifiedFile,
} from "./file_delivery";
import { readDocxCapture, readDocxPreview } from "./docx_preview";
import { DOCX_LIMITS, DocxError } from "./docx_types";
import { FILE_DELIVERY_STRINGS as D } from "./file_delivery_strings";
import { docxInputText } from "./docx_input_text";
import {
  DOCUMENT_INPUT_MAX_BYTES,
  DocumentInputError,
  documentTextBytes,
  parseApprovedDocumentText,
  parseLocalDocumentText,
  type ApprovedDocumentText,
  type LocalDocumentText,
} from "./document_input_types";

export interface DocumentInputReview {
  text: string;
  local: LocalDocumentText;
  /** Non-whitespace author text only, excluding generated document markers. */
  actualTextChars: number;
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DocumentInputError("cancelled");
}
function normalized(error: unknown): never {
  if (error instanceof DocumentInputError) throw error;
  if (error instanceof DocxError) throw new DocumentInputError(error.code);
  if (error instanceof Error && error.message === D.checkBusy)
    throw new DocumentInputError("readBusy");
  if (error instanceof Error && error.message === D.checkWaitExpired)
    throw new DocumentInputError("readPending");
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (["missing", "redirected", "changing", "notFile"].includes(String(code)))
    throw new DocumentInputError("changed");
  if (code === "busy") throw new DocumentInputError("readBusy");
  if (code === "pending") throw new DocumentInputError("readPending");
  if (code === "tooLarge") throw new DocumentInputError("limit");
  throw new DocumentInputError("unreadable");
}
/** Cancels only this wait. Native work retains its existing real OS read slot. */
async function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  cancelled(signal);
  if (!signal) return work;
  let abort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new DocumentInputError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    cancelled(signal);
    return value;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
function sameFile(a: VerifiedFile, b: VerifiedFile): boolean {
  return [
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ].every(
    (key) => a[key as keyof VerifiedFile] === b[key as keyof VerifiedFile],
  );
}
function selectedPath(uri: string): string {
  const path = localResourcePath(uri);
  if (!path) throw new DocumentInputError("sourceUnknown");
  return path;
}
async function digest(text: string, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const bytes = documentTextBytes(text, DOCUMENT_INPUT_MAX_BYTES);
  const hash = await waitFor(
    crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer),
    signal,
  );
  cancelled(signal);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function revision(
  source: VerifiedFile,
  signal?: AbortSignal,
): Promise<void> {
  cancelled(signal);
  const result = await waitFor(
    fileDelivery.checkRevision(source, "content"),
    signal,
  );
  if (result.kind !== "verified" || !sameFile(source, result.file))
    throw new DocumentInputError("changed");
}

export async function readDocumentInput(
  attachment: { uri: string; name: string },
  signal: AbortSignal,
): Promise<DocumentInputReview> {
  cancelled(signal);
  const path = selectedPath(attachment.uri);
  try {
    const source = await waitFor(fileDelivery.inspectSelected(path), signal);
    if (source.path !== path) throw new DocumentInputError("changed");
    if (source.size > DOCX_LIMITS.archive)
      throw new DocumentInputError("limit");
    const capture = await readDocxCapture(source, signal);
    const document = await readDocxPreview(capture, signal);
    cancelled(signal);
    const converted = docxInputText(document);
    if (!converted.actualTextChars) throw new DocumentInputError("noText");
    const local = parseLocalDocumentText({
      schema: 1,
      format: "docx",
      source,
      textSha256: await digest(converted.text, signal),
      utf8Bytes: documentTextBytes(converted.text, DOCUMENT_INPUT_MAX_BYTES)
        .byteLength,
      selection: "read-visible-text",
      partial: document.partial,
      partialSelected: false,
      warnings: document.warnings,
      imageReferences: converted.imageReferences,
    });
    if (!local) throw new DocumentInputError("invalid");
    cancelled(signal);
    return {
      text: converted.text,
      local,
      actualTextChars: converted.actualTextChars,
    };
  } catch (error) {
    normalized(error);
  }
}

export async function confirmDocumentInput(
  result: DocumentInputReview,
  selection: { partialSelected: boolean },
  signal?: AbortSignal,
): Promise<ApprovedDocumentText> {
  cancelled(signal);
  if (
    !Number.isSafeInteger(result.actualTextChars) ||
    result.actualTextChars <= 0
  )
    throw new DocumentInputError("noText");
  const approved = parseApprovedDocumentText({
    text: result.text,
    local: {
      ...result.local,
      partialSelected: selection.partialSelected === true,
    },
  });
  if (
    !approved.local ||
    (approved.local.partial && !approved.local.partialSelected)
  )
    throw new DocumentInputError("unsupported");
  try {
    if ((await digest(approved.text, signal)) !== approved.local.textSha256)
      throw new DocumentInputError("invalid");
    await revision(approved.local.source, signal);
    cancelled(signal);
    return approved;
  } catch (error) {
    normalized(error);
  }
}

export async function verifyDocumentInput(
  value: ApprovedDocumentText,
  uri: string,
  options: { reparse?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  cancelled(options.signal);
  const approved = parseApprovedDocumentText(value),
    local = approved.local;
  if (!local) throw new DocumentInputError("sourceUnknown");
  if (selectedPath(uri) !== local.source.path)
    throw new DocumentInputError("changed");
  if (local.partial && !local.partialSelected)
    throw new DocumentInputError("unsupported");
  try {
    if ((await digest(approved.text, options.signal)) !== local.textSha256)
      throw new DocumentInputError("invalid");
    await revision(local.source, options.signal);
    if (options.reparse) {
      const current = await readDocumentInput(
        { uri, name: local.source.name },
        options.signal ?? new AbortController().signal,
      );
      if (
        !sameFile(current.local.source, local.source) ||
        current.text !== approved.text ||
        current.local.textSha256 !== local.textSha256 ||
        current.local.utf8Bytes !== local.utf8Bytes ||
        current.local.partial !== local.partial ||
        current.local.imageReferences !== local.imageReferences ||
        JSON.stringify(current.local.warnings) !==
          JSON.stringify(local.warnings)
      )
        throw new DocumentInputError("changed");
    }
    cancelled(options.signal);
  } catch (error) {
    normalized(error);
  }
}
