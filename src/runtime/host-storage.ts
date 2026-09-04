import { invoke } from "@tauri-apps/api/core";

export type HostStorageMode = "ready" | "recovery";

export interface HostStorageStatus {
  mode: HostStorageMode;
  databasePath: string;
  schemaVersion: number | null;
  backupPath: string | null;
  recoveryReason: string | null;
}

export type HostStorageBootstrap =
  | { phase: "checking" }
  | { phase: "ready"; status: HostStorageStatus }
  | { phase: "recovery"; status: HostStorageStatus }
  | { phase: "unavailable"; reason: string };

export function getHostStorageStatus(): Promise<HostStorageStatus> {
  return invoke("host_storage_status");
}

export async function loadHostStorageBootstrap(
  readStatus: () => Promise<HostStorageStatus> = getHostStorageStatus,
): Promise<HostStorageBootstrap> {
  try {
    const status = await readStatus();
    return status.mode === "ready"
      ? { phase: "ready", status }
      : { phase: "recovery", status };
  } catch (reason) {
    return { phase: "unavailable", reason: String(reason) };
  }
}
