import { renderPdfPage } from "/src/runtime/pdf_preview";
import { renderPdfPixels } from "/src/runtime/pdf_render_core";
const events: any[] = [];
const RealWorker = Worker;
(window as any).Worker = class extends RealWorker {
  constructor(url: any, options: any) {
    super(url, options);
    events.push({ kind: "created", url: String(url), at: performance.now() });
    this.addEventListener("message", (event) =>
      events.push({
        kind: "message",
        type: event.data?.kind,
        code: event.data?.code,
        at: performance.now(),
      }),
    );
    this.addEventListener("error", () =>
      events.push({ kind: "error", at: performance.now() }),
    );
  }
  postMessage(value: any, transfer: any) {
    events.push({
      kind: "sent",
      keys: Object.keys(value),
      at: performance.now(),
    });
    return super.postMessage(value, transfer);
  }
  terminate() {
    events.push({ kind: "terminated", at: performance.now() });
    return super.terminate();
  }
};
async function run() {
  const response = await fetch(
    "/src/runtime/fixtures/pdf-preview/mixed-two-pages.pdf",
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const sampleSize = bytes.length;
  const results: any[] = [];
  let pages = 0;
  const start = performance.now();
  try {
    await renderPdfPage(
      bytes,
      document.querySelector("canvas")!,
      1,
      600,
      new AbortController().signal,
      (total) => (pages = total),
    );
    results.push({
      entry: "production renderPdfPage",
      status: "success",
      pages,
      ms: performance.now() - start,
    });
  } catch (error) {
    results.push({
      entry: "production renderPdfPage",
      status: "error",
      error: String(error),
      ms: performance.now() - start,
    });
  }
  const parser = new RealWorker(
    new URL("/src/workers/pdf_preview.worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    const ready = await Promise.race([
      new Promise<boolean>((resolve, reject) => {
        parser.addEventListener("message", (event) => {
          events.push({
            kind: "parser-message",
            action: event.data?.action,
            keys: Object.keys(event.data ?? {}),
          });
          if (event.data?.action === "ready") resolve(true);
        });
        parser.addEventListener("error", () =>
          reject(new Error("parser failed")),
        );
      }),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!ready) throw new Error("ready absent");
    const result = await Promise.race([
      renderPdfPixels(bytes, 1, 600, parser, () => false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("controlled render timeout")), 8000),
      ),
    ]);
    results.push({
      entry: "same core after actual official parser ready",
      status: "success",
      pages: result.pages,
      width: result.bitmap.width,
      height: result.bitmap.height,
    });
    result.bitmap.close();
  } catch (error) {
    results.push({
      entry: "same core after actual official parser ready",
      status: "error",
      error: String(error),
    });
  } finally {
    parser.terminate();
  }
  document.querySelector("#result")!.textContent = JSON.stringify(
    {
      passed: results.every((x) => x.status === "success"),
      sample: {
        path: "src/runtime/fixtures/pdf-preview/mixed-two-pages.pdf",
        status: response.status,
        size: sampleSize,
        sha256,
      },
      results,
      events,
    },
    null,
    2,
  );
  document.documentElement.dataset.done = "true";
}
run();
