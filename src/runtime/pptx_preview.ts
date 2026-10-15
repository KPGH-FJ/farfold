import { invoke } from "@tauri-apps/api/core";
import type { VerifiedFile } from "./file_delivery";
import { samePreviewFile } from "./preview_capture";
import {
  PPTX_LIMITS as L,
  PptxError,
  type PptxCapture,
  type PptxFailure,
  type PptxPreview,
} from "./pptx_types";
import { checkedPptxDocument } from "./pptx_validation";

const fileKeys = [
  "root",
  "path",
  "resolvedPath",
  "name",
  "size",
  "sha256",
  "version",
];
function checkedCapture(
  expected: VerifiedFile,
  value: PptxCapture,
): PptxCapture {
  if (
    !value ||
    !value.file ||
    Object.keys(value.file).length !== fileKeys.length ||
    !samePreviewFile(expected, value.file)
  )
    throw new PptxError("changed");
  if (
    Object.keys(value).some(
      (key) => !["file", "parts", "entries", "inflatedBytes"].includes(key),
    ) ||
    !Array.isArray(value.parts) ||
    !Array.isArray(value.entries)
  )
    throw new PptxError("invalid");
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > L.archive ||
    !Number.isSafeInteger(value.inflatedBytes) ||
    value.inflatedBytes < 1 ||
    value.inflatedBytes > L.bytes ||
    value.parts.length > L.entries ||
    value.entries.length > L.entries
  )
    throw new PptxError("limit");
  const entries = new Set<string>();
  for (const name of value.entries) {
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 1024 ||
      entries.has(name)
    )
      throw new PptxError("invalid");
    entries.add(name);
  }
  const parts = new Set<string>();
  let encodedBytes = 0;
  for (const part of value.parts) {
    if (
      !part ||
      typeof part !== "object" ||
      Object.keys(part).length !== 2 ||
      !Object.hasOwn(part, "name") ||
      !Object.hasOwn(part, "data") ||
      typeof part.name !== "string" ||
      typeof part.data !== "string" ||
      !entries.has(part.name) ||
      parts.has(part.name)
    )
      throw new PptxError("invalid");
    if (part.data.length > Math.ceil(L.part / 3) * 4)
      throw new PptxError("limit");
    encodedBytes += part.data.length;
    if (encodedBytes > Math.ceil(L.bytes / 3) * 4 + L.entries * 4)
      throw new PptxError("limit");
    parts.add(part.name);
  }
  return value;
}

/** Cancels this wait only. The backend retains its real read slot until the OS
 * operation finishes; view owners keep awaiting that bounded receipt. */
export async function readPptxCapture(
  file: VerifiedFile,
  signal: AbortSignal,
): Promise<PptxCapture> {
  if (signal.aborted) throw new PptxError("cancelled");
  const expected = { ...file };
  let abort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      invoke<PptxCapture>("file_delivery_read_pptx", { file: expected }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new PptxError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    if (signal.aborted) throw new PptxError("cancelled");
    return checkedCapture(expected, value);
  } catch (error) {
    if (error instanceof PptxError) throw error;
    const codes: readonly PptxFailure[] = [
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
    throw new PptxError(
      typeof code === "string" && codes.includes(code as PptxFailure)
        ? (code as PptxFailure)
        : "unreadable",
    );
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

let running = false;
export async function readPptxPreview(
  capture: PptxCapture,
  signal: AbortSignal,
): Promise<PptxPreview> {
  if (signal.aborted) throw new PptxError("cancelled");
  checkedCapture(capture.file, capture);
  const file = { ...capture.file };
  const input = {
    parts: capture.parts.map((part) => ({ ...part })),
    entries: [...capture.entries],
  };
  const capturedParts = new Set(input.parts.map((part) => part.name));
  if (typeof Worker === "undefined") throw new PptxError("unsupported");
  if (running) throw new PptxError("busy");
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
    return await new Promise<PptxPreview>((resolve, reject) => {
      let settled = false;
      const fail = (error: PptxError) => {
        if (settled) return;
        settled = true;
        dispose();
        reject(error);
      };
      abort = () => fail(new PptxError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(new PptxError("timeout")), L.wait);
      worker = new Worker(
        new URL("../workers/pptx_preview.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener("error", () => fail(new PptxError("invalid")));
      worker.addEventListener("messageerror", () =>
        fail(new PptxError("invalid")),
      );
      worker.addEventListener("message", (event) => {
        if (settled) return;
        if (event.data?.kind === "error") {
          fail(
            new PptxError(
              ["limit", "unsupported"].includes(event.data.code)
                ? event.data.code
                : "invalid",
            ),
          );
          return;
        }
        try {
          if (
            event.data?.kind !== "ready" ||
            Object.keys(event.data).some(
              (key) => !["kind", "document"].includes(key),
            )
          )
            throw new PptxError("invalid");
          const document = checkedPptxDocument(
            event.data.document,
            capturedParts,
          );
          if (signal.aborted) {
            abort?.();
            return;
          }
          settled = true;
          dispose();
          resolve({ ...document, file });
        } catch (error) {
          fail(error instanceof PptxError ? error : new PptxError("invalid"));
        }
      });
      if (signal.aborted) {
        abort();
        return;
      }
      worker.postMessage(input);
    });
  } catch (error) {
    throw error instanceof PptxError ? error : new PptxError("invalid");
  } finally {
    dispose();
  }
}
