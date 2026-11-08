import { XLSX_LIMITS, XlsxError, type WorkbookCapture } from "./xlsx_types";
import { XlsxInputError } from "./xlsx_input_types";
// Preview and complete-input reads share one slot and one resource lifecycle.
let running = 0;
export async function readXlsxWorker<T>(
  _capture: WorkbookCapture,
  payload: unknown,
  kind: "ready" | "inputReady",
  validate: (value: unknown) => T,
  signal: AbortSignal,
  onDirectory?: (value: unknown) => void,
): Promise<T> {
  if (signal.aborted) throw new XlsxError("cancelled");
  if (typeof Worker === "undefined") throw new XlsxError("unsupported");
  if (running) throw new XlsxError("busy");
  running++;
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
      running--;
    }
  };
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let directoryReceived = false;
      const fail = (error: XlsxError | XlsxInputError) => {
        if (!settled) {
          settled = true;
          dispose();
          reject(error);
        }
      };
      abort = () => fail(new XlsxError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => fail(new XlsxError("timeout")),
        XLSX_LIMITS.wait,
      );
      worker = new Worker(
        new URL("../workers/xlsx_preview.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener("error", () => fail(new XlsxError("invalid")));
      worker.addEventListener("messageerror", () =>
        fail(new XlsxError("invalid")),
      );
      worker.addEventListener("message", (event) => {
        if (settled) return;
        if (event.data?.kind === "error") {
          const code = event.data.code;
          if (code === "scopeEmpty" && kind === "inputReady")
            fail(new XlsxInputError("scopeEmpty"));
          else
            fail(
              new XlsxError(
                ["limit", "unsupported"].includes(code) ? code : "invalid",
              ),
            );
          return;
        }
        try {
          if (event.data?.kind === "directory") {
            if (
              kind !== "ready" ||
              !onDirectory ||
              directoryReceived ||
              Array.isArray(event.data) ||
              Object.keys(event.data).length !== 2 ||
              !Object.hasOwn(event.data, "kind") ||
              !Object.hasOwn(event.data, "directory")
            )
              throw new XlsxError("invalid");
            if (signal.aborted) {
              abort?.();
              return;
            }
            directoryReceived = true;
            onDirectory(event.data.directory);
            return;
          }
          if (
            !event.data ||
            Object.keys(event.data).length !== 2 ||
            event.data.kind !== kind
          )
            throw new XlsxError("invalid");
          const result = validate(event.data.workbook);
          if (signal.aborted) {
            abort?.();
            return;
          }
          settled = true;
          dispose();
          resolve(result);
        } catch {
          fail(new XlsxError("invalid"));
        }
      });
      if (signal.aborted) {
        abort();
        return;
      }
      worker.postMessage(payload);
    });
  } catch (error) {
    throw error instanceof XlsxError || error instanceof XlsxInputError
      ? error
      : new XlsxError("invalid");
  } finally {
    dispose();
  }
}
