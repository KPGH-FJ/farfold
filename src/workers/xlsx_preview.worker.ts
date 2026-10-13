import { parseWorkbook } from "../runtime/xlsx_parse";
import { XlsxError, type XlsxWorkerInput } from "../runtime/xlsx_types";
import { parseWorkbookInput } from "../runtime/xlsx_input_parse";
import {
  XlsxInputError,
  type XlsxInputWorkerInput,
} from "../runtime/xlsx_input_types";
import { checkedXlsxInputResult } from "../runtime/xlsx_input_validation";

// Only packaged code executes. The parser receives inert XML; never HTML or
// app APIs. Block accidental external requests as well as refusing DTDs.
globalThis.fetch = async () => {
  throw new Error("unsupported");
};
let started = false;
globalThis.onmessage = (
  event: MessageEvent<XlsxWorkerInput | XlsxInputWorkerInput>,
) => {
  if (started) return;
  started = true;
  try {
    if ("kind" in event.data) {
      const data = event.data;
      if (
        data.kind !== "input" ||
        Object.keys(data).some(
          (k) => !["kind", "parts", "entries", "request"].includes(k),
        )
      )
        throw new XlsxError("invalid");
      globalThis.postMessage({
        kind: "inputReady",
        workbook: checkedXlsxInputResult(
          parseWorkbookInput(data, data.request),
          undefined,
          data.request,
        ),
      });
      return;
    }
    globalThis.postMessage({
      kind: "ready",
      workbook: parseWorkbook(event.data),
    });
  } catch (error) {
    globalThis.postMessage({
      kind: "error",
      code:
        error instanceof XlsxError || error instanceof XlsxInputError
          ? error.code
          : "invalid",
    });
  }
};
