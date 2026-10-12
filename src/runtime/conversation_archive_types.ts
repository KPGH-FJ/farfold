/** Archive wire is separate from the unchanged ordinary file-copy receipt. */
type UUID = string;
type Sha256 = string;

import type { VerifiedFile } from "./file_delivery";
export interface ArchiveOrigin {
  itemOrdinal: number;
  role: "user" | "agent" | "tool";
  attachmentOrdinal: number | null;
  toolContentOrdinal: number | null;
  declaration:
    "messageAttachment" | "toolAttachment" | "resourceLink" | "reportedFile";
}
export interface ArchiveCandidateMetadata {
  candidateId: UUID;
  origin: ArchiveOrigin;
  displayName: string; // Plain metadata; never a ZIP member pathname.
  declaredMimeType: string | null; // Declaration, not validated format.
  representation:
    "localCurrentFile" | "receivedText" | "receivedBytes" | "referenceOnly";
  replacesCandidateId: UUID | null; // Explicit separately selected substitution.
}
export type ArchiveSource =
  | {
      kind: "local";
      file: VerifiedFile;
      selectedBy: "declaredSource" | "filePickerSubstitute";
    }
  | { kind: "inlineText"; text: string; utf8Bytes: number }
  | { kind: "inlineBinary"; base64: string; decodedBytes: number };
export type ArchiveOmission =
  | "notSelected"
  | "remoteNotFetched"
  | "unsupportedSource"
  | "missingPayload"
  | "changed"
  | "unreadable"
  | "tooLarge"
  | "invalidData"
  | "replacedByUserSelection";
export interface ArchivePrepareInput {
  operationId: UUID; // Established before prepare; never reused for another input.
  inputSha256: Sha256; // Private typed-envelope digest, independently recomputed by BE.
  snapshotId: UUID;
  selectionId: UUID;
  destination: string; // Only the explicit native save-picker result.
  markdown: string; // Frozen loaded subset, with archive-specific metadata policy.
  candidates: readonly ArchiveCandidateMetadata[]; // No unselected source payload.
  selected: readonly { candidateId: UUID; source: ArchiveSource }[];
  omitted: readonly { candidateId: UUID; reason: ArchiveOmission }[];
}
export interface ArchiveIdentity {
  kind: "conversationArchive";
  operationId: UUID;
  inputSha256: Sha256;
  snapshotId: UUID;
  selectionId: UUID;
  destination: string;
  includedCount: number;
  omittedCount: number;
  totalInputBytes: number; // Selected attachment bytes only; excludes Markdown/manifest/ZIP overhead.
}
export interface ArchiveProgress {
  processedInputBytes: number;
  itemsCompleted: number;
}
export interface ArchiveReceipt {
  kind: "conversationArchive";
  destination: string;
  zipSize: number;
  zipSha256: Sha256;
  manifestSha256: Sha256;
  includedCount: number;
  omittedCount: number;
  scope: "selectedLoadedSnapshot";
}
export type ArchiveCode =
  | "invalidRequest"
  | "invalidData"
  | "tooLarge"
  | "changed"
  | "unreadable"
  | "alreadyExists"
  | "invalidDestination"
  | "destinationChanged"
  | "writeFailed"
  | "cleanupUnknown"
  | "busy"
  | "unavailable"
  | "requestConflict"
  | "requestRetired"
  | "requestCapacity";
export type ArchiveStatus = ArchiveIdentity &
  ArchiveProgress &
  (
    | {
        state: "ready" | "writing" | "cancelling";
        settled: false;
        publication: "notPublished";
        receipt: null;
        code: null;
        failedCandidateId: null;
      }
    | {
        state: "publishing";
        settled: false;
        publication: "unknown";
        receipt: null;
        code: null;
        failedCandidateId: null;
      }
    | {
        state: "completed";
        settled: true;
        publication: "published";
        receipt: ArchiveReceipt;
        code: null;
        failedCandidateId: null;
      }
    | {
        state: "cancelled";
        settled: true;
        publication: "notPublished";
        receipt: null;
        code: null;
        failedCandidateId: null;
      }
    | {
        state: "failed";
        settled: true;
        publication: "notPublished";
        receipt: null;
        code: ArchiveCode;
        failedCandidateId: UUID | null;
      }
    | {
        state: "unknown";
        settled: true;
        publication: "unknown";
        receipt: null;
        code: ArchiveCode;
        failedCandidateId: UUID | null;
      }
  );
// Backend Unknown here means its worker has ended but publication or cleanup is
// unconfirmed. An IPC observer timeout belongs to FE observation state instead;
// it cannot fabricate ArchiveStatus.settled or release actual worker ownership.
export interface ArchiveAbsent {
  kind: "conversationArchive";
  operationId: UUID;
  inputSha256: Sha256;
  state: "absent";
  settled: true;
  admissionClosed: boolean;
  result: "unknown";
  scope: "currentProcess";
}
export type ArchiveReply = ArchiveStatus | ArchiveAbsent;
export interface ArchiveFailure {
  code: ArchiveCode;
}
export interface ArchiveRequestKey {
  operationId: UUID;
  inputSha256: Sha256;
}

export interface ArchivePort {
  file_archive_prepare(input: ArchivePrepareInput): Promise<ArchiveStatus>;
  file_archive_start(input: ArchiveRequestKey): Promise<ArchiveReply>;
  file_archive_status(input: ArchiveRequestKey): Promise<ArchiveReply>;
  file_archive_cancel(input: ArchiveRequestKey): Promise<ArchiveReply>;
  file_archive_release(input: ArchiveRequestKey): Promise<boolean>;
}
