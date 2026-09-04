import { invoke } from "@tauri-apps/api/core";

export type ManagedUpdateConfiguration =
  "configured" | "unconfigured" | "invalid";

export type ManagedUpdateBlocker =
  | "release_infrastructure_unconfigured"
  | "release_infrastructure_invalid"
  | "host_storage_recovery"
  | "active_turns"
  | "pending_interactions"
  | "pi_runtime_not_stopped"
  | "open_code_runtime_not_stopped"
  | "post_commit_recovery_retained";

export interface ManagedUpdateCandidate {
  candidateToken: string;
  currentVersion: string;
  version: string;
  target: string;
  notes: string | null;
  checkedAt: number;
  artifactVerified: boolean;
  bundlePreflightVerified: boolean;
  sideBySideSmokeVerified: boolean;
  candidateHostSchemaVersion: number | null;
  candidateMainExecutableSha256: string | null;
  activationRecoveryPrepared: boolean;
}

export interface ManagedUpdateSnapshot {
  channel: string;
  transport: string;
  configuration: ManagedUpdateConfiguration;
  checking: boolean;
  downloading: boolean;
  preparing: boolean;
  currentVersion: string;
  candidate: ManagedUpdateCandidate | null;
  blockers: ManagedUpdateBlocker[];
  checkEnabled: boolean;
  downloadEnabled: boolean;
  prepareActivationEnabled: boolean;
  cancelPreparedActivationEnabled: boolean;
  activateEnabled: boolean;
  activationPreflightClear: boolean;
}

export interface ManagedUpdateRecoverySnapshot {
  rollbackAvailable: boolean;
  operationId: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  requiredConfirmation: string;
  discardEnabled: boolean;
  requiredDiscardConfirmation: string;
}

export function getManagedUpdateSnapshot(): Promise<ManagedUpdateSnapshot> {
  return invoke("managed_update_snapshot");
}

export function checkManagedUpdate(): Promise<ManagedUpdateSnapshot> {
  return invoke("managed_update_check");
}

function candidateInput(candidateToken: string) {
  return { input: { expectedCandidateToken: candidateToken } };
}

export function downloadManagedUpdate(
  candidateToken: string,
): Promise<ManagedUpdateSnapshot> {
  return invoke("managed_update_download", candidateInput(candidateToken));
}

export function prepareManagedUpdate(
  candidateToken: string,
): Promise<ManagedUpdateSnapshot> {
  return invoke(
    "managed_update_prepare_activation",
    candidateInput(candidateToken),
  );
}

export function cancelPreparedManagedUpdate(
  candidateToken: string,
): Promise<ManagedUpdateSnapshot> {
  return invoke(
    "managed_update_cancel_prepared_activation",
    candidateInput(candidateToken),
  );
}

export function activateManagedUpdate(candidateToken: string): Promise<never> {
  return invoke("managed_update_activate", candidateInput(candidateToken));
}

export function getManagedUpdateRecoverySnapshot(): Promise<ManagedUpdateRecoverySnapshot> {
  return invoke("managed_update_recovery_snapshot");
}

export function requestManagedUpdateRollback(
  expectedOperationId: string,
  confirmation: string,
): Promise<never> {
  return invoke("managed_update_request_rollback", {
    input: { expectedOperationId, confirmation },
  });
}

export function discardManagedUpdateRecovery(
  expectedOperationId: string,
  confirmation: string,
): Promise<ManagedUpdateRecoverySnapshot> {
  return invoke("managed_update_discard_recovery", {
    input: { expectedOperationId, confirmation },
  });
}
