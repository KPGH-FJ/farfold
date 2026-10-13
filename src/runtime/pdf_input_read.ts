import { decodePdfInputCapture } from "./pdf_input_capture";
import {
  PDF_INPUT_LIMITS as L,
  PDF_INPUT_FAILURE_CODES,
  PdfInputError,
  type PdfInputCapture,
  type PdfInputFailure,
  type PdfInputRequest,
  type PdfInputResult,
} from "./pdf_input_types";
import {
  checkedPdfInputRequest,
  checkedPdfInputResult,
} from "./pdf_input_validation";
import { pdfInputText } from "./pdf_input_text";
import { tryAcquirePdfWorkerSlot } from "./pdf_worker_slots";

export async function readPdfInput(
  capture: PdfInputCapture,
  request: PdfInputRequest,
  signal: AbortSignal,
): Promise<PdfInputResult> {
  if (signal.aborted) throw new PdfInputError("cancelled");
  const selected = checkedPdfInputRequest(request);
  if (typeof Worker === "undefined") throw new PdfInputError("unsupported");
  const release = tryAcquirePdfWorkerSlot("input");
  if (!release) throw new PdfInputError("busy");
  let worker: Worker | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    abort: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    try {
      worker?.terminate();
    } finally {
      release();
    }
  };
  try {
    return await new Promise<PdfInputResult>((resolve, reject) => {
      let settled = false;
      const fail = (error: PdfInputError) => {
        if (settled) return;
        settled = true;
        dispose();
        reject(error);
      };
      abort = () => fail(new PdfInputError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(new PdfInputError("timeout")), L.wait);
      void (async () => {
        try {
          const data = await decodePdfInputCapture(
            capture.file,
            capture,
            signal,
          );
          if (settled) return;
          if (signal.aborted) {
            abort?.();
            return;
          }
          worker = new Worker(
            new URL("../workers/pdf_input.worker.ts", import.meta.url),
            { type: "module" },
          );
          worker.addEventListener("error", () =>
            fail(new PdfInputError("incomplete")),
          );
          worker.addEventListener("messageerror", () =>
            fail(new PdfInputError("incomplete")),
          );
          worker.addEventListener("message", (event) => {
            if (settled) return;
            const value = event.data;
            if (value?.kind === "error") {
              const code =
                typeof value.code === "string" &&
                PDF_INPUT_FAILURE_CODES.includes(value.code)
                  ? (value.code as PdfInputFailure)
                  : "incomplete";
              fail(new PdfInputError(code));
              return;
            }
            try {
              if (
                !value ||
                Object.keys(value).length !== 2 ||
                value.kind !== "inputReady"
              )
                throw new PdfInputError("invalid");
              const result = checkedPdfInputResult(value.result);
              pdfInputText(result);
              if (signal.aborted) {
                abort?.();
                return;
              }
              settled = true;
              dispose();
              resolve(result);
            } catch (error) {
              fail(
                error instanceof PdfInputError
                  ? error
                  : new PdfInputError("invalid"),
              );
            }
          });
          worker.postMessage({ data, request: selected }, [data.buffer]);
        } catch (error) {
          fail(
            error instanceof PdfInputError
              ? error
              : new PdfInputError("invalid"),
          );
        }
      })();
      if (signal.aborted) abort();
    });
  } finally {
    dispose();
  }
}
