import { STRINGS } from "./strings";
import type { DatabaseStatus } from "./storage_database_restore";

export type StorageIssueKind =
  | "readOnly"
  | "full"
  | "corrupt"
  | "permission"
  | "missing"
  | "busy"
  | "unknown";
export type StorageRecoveryStatus = {
  ready: boolean;
  issue: { kind: StorageIssueKind } | null;
  dataDirectory: string;
  databaseReplacementAvailable?: boolean;
  databaseReplacement?: DatabaseStatus | null;
};
export type StorageExportReceipt = {
  path: string;
  kind: "snapshot" | "unverifiedFiles";
};
const S = STRINGS.storageRecovery;
export function storageIssueMessage(kind: StorageIssueKind): string {
  return S.issues[kind] ?? S.issues.unknown;
}
/** Only backend code receipts are classified; arbitrary error text never
 * becomes evidence of full storage, corruption or read-only permissions. */
export function storageFailureMessage(
  error: unknown,
  fallback: string,
): string {
  const raw = error instanceof Error ? error.message : error;
  if (typeof raw !== "string") return fallback;
  const match =
    /^FARFOLD_STORAGE:(readOnly|full|corrupt|permission|missing|busy):/.exec(
      raw,
    );
  return match ? storageIssueMessage(match[1] as StorageIssueKind) : fallback;
}

export function storageExportFailure(error: unknown): {
  message: string;
  partialPath: string | null;
} {
  if (error && typeof error === "object" && "issue" in error) {
    const issue = error.issue;
    const kind =
      issue && typeof issue === "object" && "kind" in issue ? issue.kind : null;
    const message =
      kind === "full"
        ? S.exportFull
        : kind === "readOnly" || kind === "permission"
          ? S.exportReadOnly
          : S.exportFailed;
    const partialPath =
      "partialPath" in error &&
      typeof error.partialPath === "string" &&
      error.partialPath.length > 0
        ? error.partialPath
        : null;
    return { message, partialPath };
  }
  // A rejected command may not have reached export. It cannot have a verified copy path.
  return {
    message: storageFailureMessage(error, S.exportFailed),
    partialPath: null,
  };
}
