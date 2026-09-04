import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  loadHostStorageBootstrap,
  previewPortableImport,
  requestRecoveryRestore,
  type PortableImportPreview,
  type HostStorageStatus,
} from "./host-storage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const ready: HostStorageStatus = {
  mode: "ready",
  databasePath: "/profile/farfold-host.sqlite3",
  schemaVersion: 7,
  backupPath: null,
  recoveryReason: null,
};
const idleActivation = {
  phase: "idle" as const,
  sha256: null,
  rollbackPath: null,
  recoverySourceArchivePath: null,
  reason: null,
};

describe("Host storage bootstrap", () => {
  beforeEach(() => invokeMock.mockReset());

  it("admits the workspace only after a ready Host status", async () => {
    await expect(
      loadHostStorageBootstrap(
        async () => ready,
        async () => idleActivation,
      ),
    ).resolves.toEqual({
      phase: "ready",
      status: ready,
      activation: idleActivation,
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
      loadHostStorageBootstrap(
        async () => recovery,
        async () => idleActivation,
      ),
    ).resolves.toEqual({
      phase: "recovery",
      status: recovery,
      activation: idleActivation,
    });
    await expect(
      loadHostStorageBootstrap(
        async () => {
          throw new Error("IPC unavailable");
        },
        async () => idleActivation,
      ),
    ).resolves.toEqual({
      phase: "unavailable",
      reason: "Error: IPC unavailable",
    });
  });

  it("binds a recovery request to the previewed path and digest", async () => {
    const preview = {
      path: "/backup/export.farfold.sqlite3",
      sha256: "a".repeat(64),
    } as PortableImportPreview;
    invokeMock.mockResolvedValueOnce(preview).mockResolvedValueOnce({
      activation: { restartRequired: true },
    });

    await previewPortableImport(preview.path);
    await requestRecoveryRestore(preview);

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "host_portable_import_preview",
      { path: preview.path },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "host_recovery_restore_request",
      {
        input: {
          sourcePath: preview.path,
          expectedSha256: preview.sha256,
        },
      },
    );
  });
});
