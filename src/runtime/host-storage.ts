import { invoke } from "@tauri-apps/api/core";

export type HostStorageMode = "ready" | "recovery";

export interface HostStorageStatus {
  mode: HostStorageMode;
  databasePath: string;
  schemaVersion: number | null;
  backupPath: string | null;
  recoveryReason: string | null;
}

export interface PortableImportContents {
  runtimeProductCount: number;
  projectCount: number;
  workingCopyCount: number;
  sessionCount: number;
  archivedSessionCount: number;
  draftCount: number;
  draftByteCount: number;
  attentionRecordCount: number;
  nativeLocatorCount: number;
  legacyLedgerRecordCount: number;
  turnChangeReviewCount: number;
  turnChangePathCount: number;
  lifeModelDocumentByteCount: number;
  lifeModelLegacyMigrationCount: number;
}

export interface PortableImportPolicy {
  includesSessionTitles: boolean;
  includesProjectPaths: boolean;
  includesNativeLocatorPaths: boolean;
  includesLegacySourcePaths: boolean;
  includesDraftBodies: boolean;
  includesTurnChangeReviews: boolean;
  includesProviderCredentials: boolean;
  includesNativeRuntimeHistory: boolean;
  includesRuntimeDiagnostics: boolean;
  includesLifeModel: boolean;
}

export interface PortableImportPreview {
  path: string;
  byteCount: number;
  sha256: string;
  formatVersion: number;
  hostSchemaVersion: number;
  exportedAt: number;
  contents: PortableImportContents;
  policy: PortableImportPolicy;
  compatible: boolean;
  restoreEnabled: boolean;
}

export interface RequestedRecoveryRestore {
  preview: PortableImportPreview;
  staged: {
    sourcePath: string;
    stagedPath: string;
    sha256: string;
    alreadyPresent: boolean;
    activationEnabled: boolean;
  };
  activation: {
    sha256: string;
    stagedPath: string;
    alreadyRequested: boolean;
    restartRequired: boolean;
  };
}

export interface PortableImportActivationStatus {
  phase: "idle" | "activated" | "rejected" | "rolled_back";
  sha256: string | null;
  rollbackPath: string | null;
  recoverySourceArchivePath: string | null;
  reason: string | null;
}

export type HostStorageBootstrap =
  | { phase: "checking" }
  | {
      phase: "ready";
      status: HostStorageStatus;
      activation: PortableImportActivationStatus;
    }
  | {
      phase: "recovery";
      status: HostStorageStatus;
      activation: PortableImportActivationStatus;
    }
  | { phase: "unavailable"; reason: string };

export function getHostStorageStatus(): Promise<HostStorageStatus> {
  return invoke("host_storage_status");
}

export function previewPortableImport(
  path: string,
): Promise<PortableImportPreview> {
  return invoke("host_portable_import_preview", { path });
}

export function requestRecoveryRestore(
  preview: PortableImportPreview,
): Promise<RequestedRecoveryRestore> {
  return invoke("host_recovery_restore_request", {
    input: {
      sourcePath: preview.path,
      expectedSha256: preview.sha256,
    },
  });
}

export function getPortableImportActivationStatus(): Promise<PortableImportActivationStatus> {
  return invoke("host_portable_import_activation_status");
}

export async function loadHostStorageBootstrap(
  readStatus: () => Promise<HostStorageStatus> = getHostStorageStatus,
  readActivation: () => Promise<PortableImportActivationStatus> = getPortableImportActivationStatus,
): Promise<HostStorageBootstrap> {
  try {
    const [status, activation] = await Promise.all([
      readStatus(),
      readActivation(),
    ]);
    return status.mode === "ready"
      ? { phase: "ready", status, activation }
      : { phase: "recovery", status, activation };
  } catch (reason) {
    return { phase: "unavailable", reason: String(reason) };
  }
}
