import { renderPdfPixels } from "../runtime/pdf_render_core";
let failed = false,
  started = false;
const failure = (code = "incomplete") => {
  if (failed) return;
  failed = true;
  globalThis.postMessage({ kind: "error", code });
};
// Both drawing diagnostics and parser diagnostics invalidate this preview. No
// document text or library exception crosses into the app or its diagnostics.
console.warn = () => failure();
console.error = () => failure();
globalThis.onmessage = async (event: MessageEvent) => {
  if (started) return;
  started = true;
  let parser: Worker | undefined;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof Path2D === "undefined")
      throw new Error("unsupported");
    const { data, pageNumber, displayWidth } = event.data;
    if (!(data instanceof Uint8Array)) throw new Error("invalid");
    parser = new Worker(new URL("./pdf_preview.worker.ts", import.meta.url), {
      type: "module",
    });
    parser.addEventListener("error", () => failure());
    parser.addEventListener("message", (message) => {
      if (message.data?.farfoldPdfIncomplete === true) failure();
    });
    const result = await renderPdfPixels(
      data,
      pageNumber,
      displayWidth,
      parser,
      () => failed,
    );
    if (!failed)
      globalThis.postMessage(
        { kind: "ready", ...result },
        { transfer: [result.bitmap] },
      );
    else result.bitmap.close();
  } catch (error) {
    const code =
      error instanceof Error &&
      ["password", "limit", "unsupported"].includes(error.message)
        ? error.message
        : "incomplete";
    failure(code);
  } finally {
    parser?.terminate();
  }
};
