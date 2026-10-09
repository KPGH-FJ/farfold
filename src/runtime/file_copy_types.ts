import type { DeliveryReceipt, VerifiedFile } from "./file_delivery";
import { samePreviewFile } from "./preview_capture";
export type CopyState =
  | "ready"
  | "copying"
  | "cancelling"
  | "publishing"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown";
export type CopyFailureCode =
  | "invalidPath"
  | "outsideRoot"
  | "notFile"
  | "tooLarge"
  | "changed"
  | "unreadable"
  | "alreadyExists"
  | "invalidDestination"
  | "destinationChanged"
  | "writeFailed"
  | "cleanupUnknown"
  | "unavailable"
  | "busy";
export interface CopyStatus {
  operationId: string;
  file: VerifiedFile;
  destination: string;
  state: CopyState;
  settled: boolean;
  bytesCopied: number;
  total: number;
  receipt?: DeliveryReceipt;
  code?: CopyFailureCode;
}
const states: readonly string[] = [
  "ready",
  "copying",
  "cancelling",
  "publishing",
  "completed",
  "cancelled",
  "failed",
  "unknown",
];
const codes: readonly string[] = [
  "invalidPath",
  "outsideRoot",
  "notFile",
  "tooLarge",
  "changed",
  "unreadable",
  "alreadyExists",
  "invalidDestination",
  "destinationChanged",
  "writeFailed",
  "cleanupUnknown",
  "unavailable",
  "busy",
];
export function copyFailureCode(value: unknown): CopyFailureCode | undefined {
  const code =
    value && typeof value === "object" && "code" in value ? value.code : null;
  return typeof code === "string" && codes.includes(code)
    ? (code as CopyFailureCode)
    : undefined;
}
export function parseCopyStatus(
  value: unknown,
  file: VerifiedFile,
  destination: string,
  operationId?: string,
): CopyStatus {
  const v = value as CopyStatus | null;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    typeof v.operationId !== "string" ||
    !v.operationId ||
    v.operationId.length > 256 ||
    (operationId !== undefined && v.operationId !== operationId) ||
    !v.file ||
    !samePreviewFile(v.file, file) ||
    v.destination !== destination ||
    !states.includes(v.state) ||
    typeof v.settled !== "boolean" ||
    (copyTerminal(v.state) && !v.settled) ||
    (["ready", "copying", "cancelling", "publishing"].includes(v.state) &&
      v.settled) ||
    !Number.isSafeInteger(v.bytesCopied) ||
    v.bytesCopied < 0 ||
    !Number.isSafeInteger(v.total) ||
    v.total !== file.size ||
    v.bytesCopied > v.total ||
    (v.code !== undefined && !codes.includes(v.code))
  )
    throw new Error("Invalid copy receipt");
  if (v.state === "completed") {
    const r = v.receipt;
    if (
      !r ||
      r.kind !== "fileCopy" ||
      r.destination !== destination ||
      r.size !== file.size ||
      r.sha256 !== file.sha256 ||
      r.sourceVersion !== file.version ||
      v.bytesCopied !== v.total
    )
      throw new Error("Invalid completed copy receipt");
  } else if (v.receipt !== undefined)
    throw new Error("Unexpected copy receipt");
  return v;
}
export const copyTerminal = (state: CopyState) =>
  state === "completed" || state === "cancelled" || state === "failed";

export interface CopyAbsence {
  operationId: string;
  absent: true;
  settled: true;
}
export function isCopyAbsence(
  value: unknown,
  operationId: string,
): value is CopyAbsence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as CopyAbsence;
  return (
    Object.keys(value).length === 3 &&
    v.operationId === operationId &&
    v.absent === true &&
    v.settled === true
  );
}
