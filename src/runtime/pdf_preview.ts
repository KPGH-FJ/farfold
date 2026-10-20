import {
  MAX_PDF_PAGES,
  MAX_PREVIEW_EDGE,
  MAX_PREVIEW_PIXELS,
  PREVIEW_WAIT_MS,
  VISUAL_PREVIEW_STRINGS as S,
} from "./visual_preview";
import { tryAcquirePdfWorkerSlot } from "./pdf_worker_slots";

/** The app receives pixels only. Parsing and drawing both live in the owned
 * worker tree, without a document, app API, annotation DOM or PDF actions. */
export async function renderPdfPage(
  bytes: Uint8Array | (() => Uint8Array),
  canvas: HTMLCanvasElement,
  pageNumber: number,
  displayWidth: number,
  signal: AbortSignal,
  documentReady: (pages: number, actualPage?: number) => void,
  restorePage = false,
): Promise<void> {
  if (signal.aborted) throw new Error(S.cancelled);
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof ImageBitmap === "undefined"
  )
    throw new Error(S.unsupported);
  const release = tryAcquirePdfWorkerSlot("preview");
  if (!release) throw new Error(S.busy);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    // Prepare file bytes only after owning a render slot. Preparation failure
    // retires this same slot without ever starting a worker tree.
    const data = (typeof bytes === "function" ? bytes() : bytes).slice();
    if (signal.aborted) throw new Error(S.cancelled);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };
      cancel = () => fail(S.cancelled);
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => fail(S.timeout), PREVIEW_WAIT_MS);
      worker = new Worker(
        new URL("../workers/pdf_render.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.addEventListener("error", () => fail(S.failed));
      worker.addEventListener("messageerror", () => fail(S.failed));
      worker.addEventListener("message", (event) => {
        const value = event.data;
        if (settled) {
          if (value?.bitmap instanceof ImageBitmap) value.bitmap.close();
          return;
        }
        if (value?.kind === "error") {
          fail(
            value.code === "password"
              ? S.password
              : value.code === "limit"
                ? S.limit
                : value.code === "unsupported"
                  ? S.unsupported
                  : S.failed,
          );
          return;
        }
        if (value?.kind !== "ready" || !(value.bitmap instanceof ImageBitmap)) {
          fail(S.failed);
          return;
        }
        const bitmap: ImageBitmap = value.bitmap;
        try {
          if (
            signal.aborted ||
            !Number.isSafeInteger(value.pages) ||
            value.pages < 1 ||
            (!restorePage && value.pages < pageNumber) ||
            (restorePage &&
              value.pageNumber !== Math.min(pageNumber, value.pages)) ||
            (value.pageNumber !== undefined &&
              value.pageNumber !==
                (restorePage
                  ? Math.min(pageNumber, value.pages)
                  : pageNumber)) ||
            value.pages > MAX_PDF_PAGES ||
            bitmap.width < 1 ||
            bitmap.height < 1 ||
            bitmap.width > MAX_PREVIEW_EDGE ||
            bitmap.height > MAX_PREVIEW_EDGE ||
            bitmap.width * bitmap.height > MAX_PREVIEW_PIXELS
          )
            throw new Error();
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error();
          context.drawImage(bitmap, 0, 0);
          if (restorePage) documentReady(value.pages, value.pageNumber);
          else documentReady(value.pages);
          settled = true;
          resolve();
        } catch {
          fail(S.failed);
        } finally {
          bitmap.close();
        }
      });
      worker.postMessage(
        {
          data,
          pageNumber,
          displayWidth,
          ...(restorePage ? { restorePage: true } : {}),
        },
        [data.buffer],
      );
    });
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    if (
      error instanceof Error &&
      Object.values(S).includes(error.message as never)
    )
      throw error;
    throw new Error(S.failed);
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener("abort", cancel);
    // Terminating this dedicated worker also ends its descendant parser worker;
    // no library reply is needed to end the UI wait or release this render slot.
    try {
      worker?.terminate();
    } finally {
      release();
    }
  }
}
