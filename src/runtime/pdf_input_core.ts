import type { PDFDocumentLoadingTask, PDFWorker } from "pdfjs-dist";
import { pdfAssetFactory } from "./pdf_preview_assets";
import {
  PDF_INPUT_LIMITS as L,
  PDF_INPUT_SCOPE_WARNING_CODES,
  PdfInputError,
  type PdfInputPage,
  type PdfInputRequest,
  type PdfInputResult,
  type PdfInputWarning,
} from "./pdf_input_types";
import {
  checkedPdfInputRequest,
  checkedPdfInputResult,
  pdfInputGeometry,
  pdfInputUtf8,
} from "./pdf_input_validation";
import { pdfInputText } from "./pdf_input_text";

export interface PdfInputDiagnosticGate {
  failed(): boolean;
  snapshot(): Promise<number>;
}
/** The snapshot is requested from the same port, with a fresh own nonce. */
export function createPdfInputDiagnosticGate(
  port: Worker,
  owner: string,
): PdfInputDiagnosticGate & { dispose(): void } {
  let failed = false,
    liveCount = 0;
  let pending:
    | {
        nonce: string;
        resolve: (count: number) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const fail = () => {
    failed = true;
    pending?.reject(new PdfInputError("incomplete"));
    pending = undefined;
  };
  const message = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("kind" in data) ||
      typeof data.kind !== "string" ||
      !data.kind.startsWith("pdfDiagnostic")
    )
      return;
    const item = data as Record<string, unknown>;
    if (
      item.owner !== owner ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 0
    ) {
      fail();
      return;
    }
    if (item.kind === "pdfDiagnostic") {
      if (
        Object.keys(item).length !== 3 ||
        (item.count as number) <= liveCount
      ) {
        fail();
        return;
      }
      liveCount = item.count as number;
      fail();
      return;
    }
    if (
      item.kind !== "pdfDiagnosticSnapshotResult" ||
      Object.keys(item).length !== 4 ||
      !pending ||
      item.nonce !== pending.nonce ||
      (item.count as number) < liveCount
    ) {
      fail();
      return;
    }
    const reply = pending;
    pending = undefined;
    reply.resolve(item.count as number);
  };
  port.addEventListener("message", message);
  port.addEventListener("error", fail);
  port.addEventListener("messageerror", fail);
  return {
    failed: () => failed,
    snapshot: () => {
      if (failed || pending)
        return Promise.reject(new PdfInputError("incomplete"));
      return new Promise<number>((resolve, reject) => {
        const nonce = crypto.randomUUID();
        pending = { nonce, resolve, reject };
        try {
          port.postMessage({ kind: "pdfDiagnosticSnapshot", owner, nonce });
        } catch {
          fail();
        }
      });
    },
    dispose: () => {
      port.removeEventListener("message", message);
      port.removeEventListener("error", fail);
      port.removeEventListener("messageerror", fail);
      pending?.reject(new PdfInputError("incomplete"));
      pending = undefined;
    },
  };
}

/** No fake-worker fallback. Results remain private until cleanup and diagnostics
 * pass. This checks tracked work in the locked library, not silent decoding or
 * completeness of every possible future parser diagnostic. */
export async function extractPdfInput(
  data: Uint8Array,
  request: PdfInputRequest,
  parserPort: Worker,
  diagnostics: PdfInputDiagnosticGate,
  localFailed: () => boolean,
): Promise<PdfInputResult> {
  const selected = checkedPdfInputRequest(request);
  if (!parserPort) throw new PdfInputError("unsupported");
  if (
    !(data instanceof Uint8Array) ||
    data.byteLength < 5 ||
    data.byteLength > L.sourceBytes ||
    String.fromCharCode(...data.subarray(0, 5)) !== "%PDF-"
  )
    throw new PdfInputError("invalid");
  const resources = new AbortController();
  const check = () => {
    if (localFailed() || diagnostics.failed())
      throw new PdfInputError("incomplete");
  };
  let loading: PDFDocumentLoadingTask | undefined,
    worker: PDFWorker | undefined;
  let destroyAttempted = false;
  try {
    const api = await import("pdfjs-dist/legacy/build/pdf.mjs");
    check();
    worker = api.PDFWorker.create({
      port: parserPort,
      verbosity: api.VerbosityLevel.WARNINGS,
    });
    loading = api.getDocument({
      data,
      worker,
      enableXfa: false,
      stopAtErrors: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      BinaryDataFactory: pdfAssetFactory(resources.signal),
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      verbosity: api.VerbosityLevel.WARNINGS,
    });
    const locked = new Promise<never>((_, reject) => {
      loading!.onPassword = () => reject(new PdfInputError("encrypted"));
    });
    const pdf = await Promise.race([loading.promise, locked]);
    check();
    if ((await pdf.getPermissions()) !== null)
      throw new PdfInputError("encrypted");
    // With enableXfa:false, isPureXfa alone is false even for saved pure XFA.
    // Official metadata detects its presence without enabling or reading forms.
    const metadata = await pdf.getMetadata();
    const info: unknown = metadata.info;
    const xfa =
      info && typeof info === "object" && "IsXFAPresent" in info
        ? info.IsXFAPresent
        : undefined;
    if (typeof xfa !== "boolean" || xfa || pdf.isPureXfa)
      throw new PdfInputError("unsupported");
    check();
    if (
      !Number.isSafeInteger(pdf.numPages) ||
      pdf.numPages < 1 ||
      pdf.numPages > L.pages
    )
      throw new PdfInputError("limit");
    const pages: PdfInputPage[] = [];
    let totalItems = 0,
      totalTextBytes = 0,
      emptyPages = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      check();
      const page = await pdf.getPage(number);
      if (![0, 90, 180, 270].includes(page.rotate))
        throw new PdfInputError("invalid");
      const reader = page
        .streamTextContent({
          includeMarkedContent: false,
          disableNormalization: true,
        })
        .getReader();
      const items: PdfInputPage["items"] = [];
      let authored = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          check();
          if (chunk.done) break;
          if (!chunk.value || !Array.isArray(chunk.value.items))
            throw new PdfInputError("invalid");
          for (const item of chunk.value.items) {
            if (
              !item ||
              typeof item.str !== "string" ||
              !["ltr", "rtl", "ttb"].includes(item.dir) ||
              typeof item.hasEOL !== "boolean"
            )
              throw new PdfInputError("invalid");
            if (++totalItems > L.items) throw new PdfInputError("limit");
            totalTextBytes += pdfInputUtf8(item.str).byteLength;
            if (totalTextBytes > L.textBytes)
              throw new PdfInputError("textLimit");
            if (/\S/u.test(item.str)) authored = true;
            const geometry = pdfInputGeometry(item);
            items.push({
              text: item.str,
              dir: item.dir,
              hasEOL: item.hasEOL,
              ...(geometry ? { geometry } : {}),
            });
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!authored) emptyPages++;
      pages.push({
        number,
        decodedRotation: page.rotate as 0 | 90 | 180 | 270,
        items,
      });
      page.cleanup();
    }
    const warnings: PdfInputWarning[] = PDF_INPUT_SCOPE_WARNING_CODES.map(
      (code) => ({ code, count: 1, unit: "scope" }),
    );
    if (emptyPages)
      warnings.push({
        code: "pagesWithoutText",
        count: emptyPages,
        unit: "pages",
      });
    const result = checkedPdfInputResult({
      scope: {
        ...selected,
        pageCount: pdf.numPages,
        readPageNumbers: pages.map((p) => p.number),
        extraction: "pdfjs-text-content-v1",
      },
      pages,
      partial: true,
      warnings,
    });
    pdfInputText(result); // Final serialization and scope text share one budget.
    destroyAttempted = true;
    await loading.destroy();
    check();
    if ((await diagnostics.snapshot()) !== 0)
      throw new PdfInputError("incomplete");
    check();
    return result;
  } catch (error) {
    if (error instanceof PdfInputError) throw error;
    throw new PdfInputError("incomplete");
  } finally {
    resources.abort();
    try {
      if (loading && !destroyAttempted) {
        destroyAttempted = true;
        await loading.destroy();
      }
    } catch {
      throw new PdfInputError("incomplete");
    } finally {
      worker?.destroy();
    }
  }
}
