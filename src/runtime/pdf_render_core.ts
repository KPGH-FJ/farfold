import {
  MAX_PDF_PAGES,
  MAX_PREVIEW_EDGE,
  MAX_PREVIEW_PIXELS,
} from "./visual_preview";
import { pdfAssetFactory } from "./pdf_preview_assets";
import type { PDFDocumentLoadingTask, PDFWorker, RenderTask } from "pdfjs-dist";

export function pdfCanvasSize(
  width: number,
  height: number,
  displayWidth: number,
) {
  if (![width, height, displayWidth].every((v) => Number.isFinite(v) && v > 0))
    throw new Error("invalid");
  const scale = Math.min(
    displayWidth / width,
    2,
    MAX_PREVIEW_EDGE / width,
    MAX_PREVIEW_EDGE / height,
    Math.sqrt(MAX_PREVIEW_PIXELS / (width * height)),
  );
  const w = Math.floor(width * scale),
    h = Math.floor(height * scale);
  if (w < 1 || h < 1 || w * h > MAX_PREVIEW_PIXELS) throw new Error("limit");
  return { scale, width: w, height: h };
}

/** Bound explicit canvas allocations, not the PDF parser's whole heap. */
export function canvasFactory() {
  const allocations = new Map<OffscreenCanvas, number>();
  let pixels = 0;
  const reserve = (width: number, height: number, previous = 0) => {
    if (
      ![width, height].every(
        (v) => Number.isSafeInteger(v) && v > 0 && v <= MAX_PREVIEW_EDGE,
      ) ||
      width * height > MAX_PREVIEW_PIXELS ||
      pixels - previous + width * height > 2 * MAX_PREVIEW_PIXELS
    )
      throw new Error("limit");
    pixels += width * height - previous;
  };
  return class {
    create(width: number, height: number) {
      reserve(width, height);
      const canvas = new OffscreenCanvas(width, height);
      allocations.set(canvas, width * height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("unsupported");
      return { canvas, context };
    }
    reset(target: { canvas: OffscreenCanvas }, width: number, height: number) {
      reserve(width, height, allocations.get(target.canvas) ?? 0);
      allocations.set(target.canvas, width * height);
      target.canvas.width = width;
      target.canvas.height = height;
    }
    destroy(target: { canvas: OffscreenCanvas }) {
      pixels -= allocations.get(target.canvas) ?? 0;
      allocations.delete(target.canvas);
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
  };
}

// SVG filters require a DOM. Refuse those pages instead of silently replacing a
// requested color/alpha transfer with "none" and claiming complete rendering.
export class PassiveFilterFactory {
  addFilter(maps: unknown) {
    if (maps) throw new Error("unsupported");
    return "none";
  }
  addAlphaFilter() {
    throw new Error("unsupported");
  }
  addLuminosityFilter() {
    throw new Error("unsupported");
  }
  addKnockoutFilter() {
    throw new Error("unsupported");
  }
  addHCMFilter() {
    throw new Error("unsupported");
  }
  destroy() {}
}

export async function renderPdfPixels(
  data: Uint8Array,
  pageNumber: number,
  displayWidth: number,
  parserPort: Worker | undefined,
  failed: () => boolean,
) {
  const api = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (failed()) throw new Error("incomplete");
  const resources = new AbortController();
  let worker: PDFWorker | undefined,
    loading: PDFDocumentLoadingTask | undefined,
    render: RenderTask | undefined;
  const CanvasFactory = canvasFactory();
  try {
    if (parserPort) worker = api.PDFWorker.create({ port: parserPort });
    // 6.3.289 can settle a render before rejecting an operator-stream error in
    // stopAtErrors mode. Its recoverable branch reports a warning instead; our
    // dedicated worker treats every such warning as fatal, never as success.
    loading = api.getDocument({
      data,
      worker,
      enableXfa: false,
      stopAtErrors: false,
      maxImageSize: MAX_PREVIEW_PIXELS,
      canvasMaxAreaInBytes: MAX_PREVIEW_PIXELS * 4,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      BinaryDataFactory: pdfAssetFactory(resources.signal),
      CanvasFactory,
      FilterFactory: PassiveFilterFactory,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: api.VerbosityLevel.WARNINGS,
    });
    // The worker wrapper maps this to a fixed error. No password is requested or retained.
    let password = false;
    const locked = new Promise<never>((_, reject) => {
      loading!.onPassword = () => {
        password = true;
        reject(new Error("password"));
      };
    });
    const pdf = await Promise.race([loading.promise, locked]);
    if (password) throw new Error("password");
    if (failed()) throw new Error("incomplete");
    if (
      !Number.isSafeInteger(pdf.numPages) ||
      pdf.numPages < 1 ||
      pdf.numPages > MAX_PDF_PAGES
    )
      throw new Error("limit");
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > pdf.numPages ||
      pdf.isPureXfa
    )
      throw new Error("unsupported");
    const page = await pdf.getPage(pageNumber);
    const initial = page.getViewport({ scale: 1 });
    const size = pdfCanvasSize(initial.width, initial.height, displayWidth);
    const { canvas, context } = new CanvasFactory().create(
      size.width,
      size.height,
    );
    render = page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport: page.getViewport({ scale: size.scale }),
      intent: "print",
      annotationMode: api.AnnotationMode.ENABLE,
    });
    await render.promise;
    // In the locked PDF.js version, a missing font may paint fallback/missing
    // glyphs without warning. Inspect the exact fonts used by this page, not its
    // apparent nonblankness. These are library objects, never app metadata.
    const operators = await page.getOperatorList({ intent: "print" });
    const fonts = new Set<string>();
    const inspectFonts = (list: {
      fnArray: ArrayLike<number>;
      argsArray: unknown[][];
    }) => {
      for (let i = 0; i < list.fnArray.length; i++) {
        if (list.fnArray[i] !== api.OPS.setFont) continue;
        const id = list.argsArray[i][0];
        if (typeof id !== "string" || fonts.has(id)) continue;
        fonts.add(id);
        const font = page.commonObjs.get(id);
        if (!font || font.missingFile || font.isInvalidPDFjsFont)
          throw new Error("incomplete");
        if (font.charProcOperatorList instanceof Map)
          for (const child of font.charProcOperatorList.values())
            inspectFonts(child);
      }
    };
    inspectFonts(operators);
    if (failed()) throw new Error("incomplete");
    return { bitmap: canvas.transferToImageBitmap(), pages: pdf.numPages };
  } finally {
    resources.abort();
    try {
      render?.cancel();
    } catch {
      /* Dedicated parent owns termination. */
    }
    try {
      if (loading) void loading.destroy().catch(() => {});
    } catch {
      /* See above. */
    }
    try {
      worker?.destroy();
    } catch {
      /* See above. */
    }
  }
}
