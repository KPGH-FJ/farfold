import {
  createPdfInputDiagnosticGate,
  extractPdfInput,
} from "../runtime/pdf_input_core";
import {
  PDF_INPUT_FAILURE_CODES,
  PdfInputError,
  type PdfInputFailure,
} from "../runtime/pdf_input_types";
import { checkedPdfInputRequest } from "../runtime/pdf_input_validation";
import parserUrl from "./pdf_input_parser.worker?worker&url";

let started = false,
  failed = false;
// Local library emissions are also fatal. Raw arguments never leave this tree.
console.warn = console.error = () => {
  failed = true;
};
globalThis.onmessage = async (event: MessageEvent) => {
  if (started) return;
  started = true;
  let parser: Worker | undefined,
    gate: ReturnType<typeof createPdfInputDiagnosticGate> | undefined;
  let result,
    code: PdfInputFailure = "incomplete";
  try {
    const value = event.data;
    if (
      !value ||
      Object.keys(value).length !== 2 ||
      !(value.data instanceof Uint8Array)
    )
      throw new PdfInputError("invalid");
    const request = checkedPdfInputRequest(value.request);
    if (
      typeof Worker === "undefined" ||
      typeof globalThis.crypto?.randomUUID !== "function"
    )
      throw new PdfInputError("unsupported");
    const owner = crypto.randomUUID();
    // Vite bundles this static worker import before adding our own job query.
    // A variable new URL('.ts', ...) alone would emit raw TS as an asset.
    const url = new URL(parserUrl, import.meta.url);
    url.searchParams.set("pdfInputOwner", owner);
    parser = new Worker(url, { type: "module" });
    gate = createPdfInputDiagnosticGate(parser, owner);
    result = await extractPdfInput(
      value.data,
      request,
      parser,
      gate,
      () => failed,
    );
  } catch (error) {
    code =
      error instanceof PdfInputError &&
      PDF_INPUT_FAILURE_CODES.includes(error.code)
        ? error.code
        : "incomplete";
  } finally {
    // Terminate the exact port that supplied the snapshot before publishing.
    if (gate?.failed()) result = undefined;
    parser?.terminate();
    gate?.dispose();
  }
  if (result && !failed) globalThis.postMessage({ kind: "inputReady", result });
  else globalThis.postMessage({ kind: "error", code });
};
