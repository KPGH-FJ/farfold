import { invoke } from "@tauri-apps/api/core";

export interface ProgramFile {
  path: string;
  sha256: string;
}

export interface CodexInstallationInspection {
  selectedPath: string;
  version: string;
  launch:
    | { kind: "native"; executable: ProgramFile }
    | {
        kind: "npm";
        interpreter: ProgramFile;
        launcher: ProgramFile;
        executable: ProgramFile;
      };
  resources: ProgramFile[];
  verifiedAt: number;
}

export interface CodexCandidates {
  paths: string[];
  warnings: string[];
}

export function findCodexCandidates(): Promise<CodexCandidates> {
  return invoke("codex_installation_candidates");
}

export function inspectCodexInstallation(
  path: string,
): Promise<CodexInstallationInspection> {
  return invoke("codex_installation_inspect", { path });
}

export interface SavedCodexInstallation {
  installationId: string;
  runtimeBuildId: string;
  inspection: CodexInstallationInspection;
}

export function listCodexInstallations(): Promise<SavedCodexInstallation[]> {
  return invoke("codex_installation_list");
}

export function acceptCodexInstallation(
  expected: CodexInstallationInspection,
): Promise<SavedCodexInstallation> {
  return invoke("codex_installation_accept", { expected });
}

export function recheckCodexInstallation(
  installationId: string,
  path?: string,
): Promise<SavedCodexInstallation> {
  return invoke("codex_installation_recheck", {
    installationId,
    path: path ?? null,
  });
}
