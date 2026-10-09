import { parseWorkbook } from "../runtime/xlsx_parse";
import { XlsxError, type XlsxWorkerInput } from "../runtime/xlsx_types";

// Only packaged code executes. The parser receives inert XML; never HTML or
// app APIs. Block accidental external requests as well as refusing DTDs.
globalThis.fetch = async () => {
  throw new Error("unsupported");
};
let started = false;
globalThis.onmessage = (event: MessageEvent<XlsxWorkerInput>) => {
  if (started) return;
  started = true;
  try {
    globalThis.postMessage({
      kind: "ready",
      workbook: parseWorkbook(event.data),
    });
  } catch (error) {
    globalThis.postMessage({
      kind: "error",
      code: error instanceof XlsxError ? error.code : "invalid",
    });
  }
};
