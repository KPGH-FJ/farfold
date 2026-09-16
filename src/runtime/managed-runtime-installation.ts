import { invoke } from "@tauri-apps/api/core";
import type { RuntimeIdentity } from "./adapter";

export type ManagedRuntimeProduct = "pi" | "opencode" | "opencode_acp";

export type ManagedRuntimeCandidateSource =
  "bundled" | "environment" | "path" | "common" | "manual";

export interface ManagedRuntimeCandidatePath {
  path: string;
  source: ManagedRuntimeCandidateSource;
}

export interface ManagedRuntimeCandidates {
  runtime: RuntimeIdentity;
  paths: ManagedRuntimeCandidatePath[];
  warnings: string[];
}

export interface ManagedRuntimeCandidateInspection {
  runtime: RuntimeIdentity;
  displayName: string;
  selectedPath: string;
  canonicalPath: string;
  source: ManagedRuntimeCandidateSource;
  distribution: "managed_bundled" | "system";
  observedVersion: string;
  expectedVersion: string;
  artifactSha256: string;
  expectedSha256: string | null;
  compatible: boolean;
  launchReferenceAvailable: boolean;
  activation: "checked_not_active" | "incompatible";
  verifiedAt: number;
}

export interface ManagedRuntimeSavedInstallation {
  installationId: string;
  runtimeBuildId: string;
  connectionId: string;
  inspection: ManagedRuntimeCandidateInspection;
}

export interface ManagedRuntimeConnectionSelection {
  installationId: string;
  connectionId: string;
  adapterId: string;
  label: string;
  selectedPath: string;
  canonicalPath: string;
}

export interface ManagedRuntimeInstallationStatus {
  runtime: ManagedRuntimeProduct;
  phase: "idle" | "running" | "cancelling";
  cancellable: boolean;
}

export function managedRuntimeConnectionSelection(
  saved: ManagedRuntimeSavedInstallation,
): ManagedRuntimeConnectionSelection {
  return {
    installationId: saved.installationId,
    connectionId: saved.connectionId,
    adapterId: saved.inspection.runtime.adapterId,
    label: `${saved.inspection.displayName} ${saved.inspection.observedVersion}`,
    selectedPath: saved.inspection.selectedPath,
    canonicalPath: saved.inspection.canonicalPath,
  };
}

export function managedRuntimeInstallationCandidates(
  runtime: ManagedRuntimeProduct,
): Promise<ManagedRuntimeCandidates> {
  return invoke("managed_runtime_installation_candidates", { runtime });
}

export function inspectManagedRuntimeInstallation(
  runtime: ManagedRuntimeProduct,
  path: string,
  source: ManagedRuntimeCandidateSource = "manual",
): Promise<ManagedRuntimeCandidateInspection> {
  return invoke("managed_runtime_installation_inspect", {
    input: { runtime, path, source },
  });
}

export function listManagedRuntimeInstallations(
  runtime: ManagedRuntimeProduct,
): Promise<ManagedRuntimeSavedInstallation[]> {
  return invoke("managed_runtime_installation_list", { runtime });
}

export function acceptManagedRuntimeInstallation(
  runtime: ManagedRuntimeProduct,
  path: string,
  source: ManagedRuntimeCandidateSource = "manual",
): Promise<ManagedRuntimeSavedInstallation> {
  return invoke("managed_runtime_installation_accept", {
    input: { runtime, path, source },
  });
}

export function installManagedRuntime(
  runtime: ManagedRuntimeProduct,
): Promise<ManagedRuntimeSavedInstallation> {
  return invoke("managed_runtime_installation_install", { runtime });
}

export function managedRuntimeInstallationStatus(
  runtime: ManagedRuntimeProduct,
): Promise<ManagedRuntimeInstallationStatus> {
  return invoke("managed_runtime_installation_status", { runtime });
}

export function cancelManagedRuntimeInstallation(
  runtime: ManagedRuntimeProduct,
): Promise<ManagedRuntimeInstallationStatus> {
  return invoke("managed_runtime_installation_cancel", { runtime });
}
