import { invoke } from "@tauri-apps/api/core";
import type { VerifiedFile } from "./file_delivery";
import {
  DOCX_LIMITS,
  DocxError,
  type DocxFailure,
  type DocxCapture,
  type DocxPreview,
} from "./docx_types";
import { checkedDocxDocument } from "./docx_validation";
function checkedCapture(
  expected: VerifiedFile,
  value: DocxCapture,
): DocxCapture {
  if (
    !value ||
    !value.file ||
    !(Object.keys(expected) as (keyof VerifiedFile)[]).every(
      (key) => expected[key] === value.file[key],
    )
  )
    throw new DocxError("changed");
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > DOCX_LIMITS.archive ||
    !Number.isSafeInteger(value.inflatedBytes) ||
    value.inflatedBytes < 1 ||
    value.inflatedBytes > DOCX_LIMITS.bytes ||
    !Array.isArray(value.parts) ||
    !Array.isArray(value.entries) ||
    value.parts.length > DOCX_LIMITS.entries ||
    value.entries.length > DOCX_LIMITS.entries
  )
    throw new DocxError("limit");
  return value;
}
/** Only cancels this wait; the bounded backend owns its real OS read slot. */
export async function readDocxCapture(
  file: VerifiedFile,
  signal: AbortSignal,
): Promise<DocxCapture> {
  if (signal.aborted) throw new DocxError("cancelled");
  const expected = { ...file };
  let abort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      invoke<DocxCapture>("file_delivery_read_docx", { file: expected }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new DocxError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    if (signal.aborted) throw new DocxError("cancelled");
    return checkedCapture(expected, value);
  } catch (error) {
    if (error instanceof DocxError) throw error;
    const codes: readonly DocxFailure[] = [
      "changed",
      "unreadable",
      "encrypted",
      "invalid",
      "limit",
      "unsupported",
      "readPending",
      "readBusy",
    ];
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    throw new DocxError(
      typeof code === "string" && codes.includes(code as DocxFailure)
        ? (code as DocxFailure)
        : "unreadable",
    );
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
let running = false;
export async function readDocxPreview(
  capture: DocxCapture,
  signal: AbortSignal,
): Promise<DocxPreview> {
  if (signal.aborted) throw new DocxError("cancelled");
  checkedCapture(capture.file, capture);
  const file = { ...capture.file };
  if (typeof Worker === "undefined") throw new DocxError("unsupported");
  if (running) throw new DocxError("busy");
  running = true;
  let worker: Worker | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    abort: (() => void) | undefined,
    disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    try {
      worker?.terminate();
    } finally {
      running = false;
    }
  };
  try {
    return await new Promise<DocxPreview>((resolve, reject) => {
      let settled = false;
      const fail = (error: DocxError) => {
        if (!settled) {
          settled = true;
          dispose();
          reject(error);
        }
      };
      abort = () => fail(new DocxError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => fail(new DocxError("timeout")),
        DOCX_LIMITS.wait,
      );
      worker = new Worker(
        new URL("../workers/docx_preview.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener("error", () => fail(new DocxError("invalid")));
      worker.addEventListener("messageerror", () =>
        fail(new DocxError("invalid")),
      );
      worker.addEventListener("message", (event) => {
        if (settled) return;
        if (event.data?.kind === "error") {
          fail(
            new DocxError(
              ["limit", "unsupported"].includes(event.data.code)
                ? event.data.code
                : "invalid",
            ),
          );
          return;
        }
        try {
          if (event.data?.kind !== "ready") throw new DocxError("invalid");
          const document = checkedDocxDocument(event.data.document);
          if (signal.aborted) {
            abort?.();
            return;
          }
          settled = true;
          dispose();
          resolve({ ...document, file });
        } catch {
          fail(new DocxError("invalid"));
        }
      });
      if (signal.aborted) {
        abort();
        return;
      }
      worker.postMessage({ parts: capture.parts, entries: capture.entries });
    });
  } catch (error) {
    throw error instanceof DocxError ? error : new DocxError("invalid");
  } finally {
    dispose();
  }
}
