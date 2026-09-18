/**
 * Managed update client: invoke wrappers over `managed_update_*` commands.
 * Shapes mirror `managed_update.rs` serde output (camelCase).
 */
import { invoke } from "@tauri-apps/api/core";

export type ManagedUpdateConfiguration =
  "configured" | "unconfigured" | "invalid";

export type ManagedUpdateBlocker =
  "release_infrastructure_unconfigured" | "release_infrastructure_invalid";

export interface ManagedUpdateCandidate {
  candidateToken: string;
  currentVersion: string;
  version: string;
  target: string;
  notes: string | null;
  checkedAt: number;
}

export interface ManagedUpdateSnapshot {
  configuration: ManagedUpdateConfiguration;
  checking: boolean;
  installing: boolean;
  currentVersion: string;
  candidate: ManagedUpdateCandidate | null;
  blockers: ManagedUpdateBlocker[];
}

export function managedUpdateSnapshot(): Promise<ManagedUpdateSnapshot> {
  return invoke("managed_update_snapshot");
}

export function managedUpdateCheck(): Promise<ManagedUpdateSnapshot> {
  return invoke("managed_update_check");
}

export function managedUpdateInstall(
  expectedCandidateToken: string,
): Promise<void> {
  return invoke("managed_update_install", {
    input: { expectedCandidateToken },
  });
}
