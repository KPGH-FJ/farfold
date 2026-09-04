import { describe, expect, it } from "vitest";
import {
  loadHostStorageBootstrap,
  type HostStorageStatus,
} from "./host-storage";

const ready: HostStorageStatus = {
  mode: "ready",
  databasePath: "/profile/farfold-host.sqlite3",
  schemaVersion: 7,
  backupPath: null,
  recoveryReason: null,
};

describe("Host storage bootstrap", () => {
  it("admits the workspace only after a ready Host status", async () => {
    await expect(loadHostStorageBootstrap(async () => ready)).resolves.toEqual({
      phase: "ready",
      status: ready,
    });
  });

  it("keeps recovery and unreadable storage fail-closed", async () => {
    const recovery: HostStorageStatus = {
      ...ready,
      mode: "recovery",
      schemaVersion: null,
      backupPath: "/profile/farfold-host.backup.sqlite3",
      recoveryReason: "Host database integrity check failed",
    };
    await expect(
      loadHostStorageBootstrap(async () => recovery),
    ).resolves.toEqual({ phase: "recovery", status: recovery });
    await expect(
      loadHostStorageBootstrap(async () => {
        throw new Error("IPC unavailable");
      }),
    ).resolves.toEqual({
      phase: "unavailable",
      reason: "Error: IPC unavailable",
    });
  });
});
