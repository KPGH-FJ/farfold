import { readXlsxWorker } from "./xlsx_worker_read";
import {
  checkedXlsxInputRequest,
  type XlsxInputRequest,
  type XlsxInputResult,
} from "./xlsx_input_types";
import { checkedXlsxInputResult } from "./xlsx_input_validation";
import { invoke } from "@tauri-apps/api/core";
import type { VerifiedFile } from "./file_delivery";
import {
  XLSX_LIMITS,
  XLSX_WARNING_CODES,
  XlsxError,
  type XlsxFailure,
  type WorkbookCapture,
  type WorkbookPreview,
} from "./xlsx_types";

function checkedCapture(
  expected: VerifiedFile,
  value: WorkbookCapture,
): WorkbookCapture {
  if (
    !value ||
    !value.file ||
    !(Object.keys(expected) as (keyof VerifiedFile)[]).every(
      (k) => expected[k] === value.file[k],
    )
  )
    throw new XlsxError("changed");
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(value.inflatedBytes) ||
    value.inflatedBytes < 1 ||
    value.inflatedBytes > XLSX_LIMITS.bytes ||
    !Array.isArray(value.parts) ||
    !Array.isArray(value.entries) ||
    value.entries.length > XLSX_LIMITS.parts ||
    value.parts.length > XLSX_LIMITS.parts
  )
    throw new XlsxError("limit");
  return value;
}
/** Cancels only the frontend wait. The bounded backend read keeps its own slot
 * until the real OS operation ends; this does not claim to abort that OS call. */
export async function readWorkbookCapture(
  file: VerifiedFile,
  signal: AbortSignal,
): Promise<WorkbookCapture> {
  if (signal.aborted) throw new XlsxError("cancelled");
  const expected = { ...file };
  let abort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      invoke<WorkbookCapture>("file_delivery_read_workbook", {
        file: expected,
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new XlsxError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    if (signal.aborted) throw new XlsxError("cancelled");
    return checkedCapture(expected, value);
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    const codes: readonly XlsxFailure[] = [
      "changed",
      "unreadable",
      "encrypted",
      "invalid",
      "limit",
      "unsupported",
      "readPending",
      "readBusy",
    ];
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    throw new XlsxError(
      typeof code === "string" && codes.includes(code as XlsxFailure)
        ? (code as XlsxFailure)
        : "unreadable",
    );
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
function checkedResult(value: WorkbookPreview): WorkbookPreview {
  if (
    !value ||
    typeof value.date1904 !== "boolean" ||
    !Array.isArray(value.sheets) ||
    !value.sheets.length ||
    value.sheets.length > XLSX_LIMITS.sheets ||
    !Array.isArray(value.styles) ||
    !value.styles.length ||
    value.styles.length > XLSX_LIMITS.styles ||
    !value.sheet ||
    !Array.isArray(value.sheet.cells) ||
    value.sheet.cells.length > XLSX_LIMITS.cells ||
    !Array.isArray(value.sheet.merges) ||
    value.sheet.merges.length > XLSX_LIMITS.merges ||
    !Array.isArray(value.warnings) ||
    value.warnings.some(
      (w) => !(XLSX_WARNING_CODES as readonly string[]).includes(w),
    )
  )
    throw new XlsxError("invalid");
  if (!value.sheets.some((s) => s.id === value.sheet!.id))
    throw new XlsxError("invalid");
  return value;
}
export async function readWorkbookPreview(
  capture: WorkbookCapture,
  sheetId: string | undefined,
  signal: AbortSignal,
): Promise<WorkbookPreview> {
  if (signal.aborted) throw new XlsxError("cancelled");
  checkedCapture(capture.file, capture);
  return readXlsxWorker(
    capture,
    { parts: capture.parts, entries: capture.entries, sheetId },
    "ready",
    (value) => {
      const result = checkedResult(value as WorkbookPreview);
      if (sheetId !== undefined && result.sheet?.id !== sheetId)
        throw new XlsxError("invalid");
      return result;
    },
    signal,
  );
}

export async function readWorkbookInput(
  capture: WorkbookCapture,
  request: XlsxInputRequest,
  signal: AbortSignal,
): Promise<XlsxInputResult> {
  if (signal.aborted) throw new XlsxError("cancelled");
  checkedCapture(capture.file, capture);
  const selected = checkedXlsxInputRequest(request);
  return readXlsxWorker(
    capture,
    {
      kind: "input",
      parts: capture.parts,
      entries: capture.entries,
      request: selected,
    },
    "inputReady",
    (value) => checkedXlsxInputResult(value, capture, selected),
    signal,
  );
}
