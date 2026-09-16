import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  acceptManagedRuntimeInstallation,
  cancelManagedRuntimeInstallation,
  installManagedRuntime,
  inspectManagedRuntimeInstallation,
  listManagedRuntimeInstallations,
  managedRuntimeConnectionSelection,
  managedRuntimeInstallationStatus,
  managedRuntimeInstallationCandidates,
  type ManagedRuntimeSavedInstallation,
} from "./managed-runtime-installation";

describe("managed Runtime installation API", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("reads Pi/OpenCode candidates through Host commands", async () => {
    await managedRuntimeInstallationCandidates("pi");
    await inspectManagedRuntimeInstallation(
      "opencode_acp",
      "/Applications/opencode",
      "path",
    );
    await listManagedRuntimeInstallations("opencode_acp");
    await acceptManagedRuntimeInstallation("pi", "/Users/me/.local/bin/pi");
    await installManagedRuntime("opencode_acp");
    await managedRuntimeInstallationStatus("opencode_acp");
    await cancelManagedRuntimeInstallation("opencode_acp");

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "managed_runtime_installation_candidates",
      { runtime: "pi" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "managed_runtime_installation_inspect",
      {
        input: {
          runtime: "opencode_acp",
          path: "/Applications/opencode",
          source: "path",
        },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      "managed_runtime_installation_list",
      { runtime: "opencode_acp" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      4,
      "managed_runtime_installation_accept",
      {
        input: {
          runtime: "pi",
          path: "/Users/me/.local/bin/pi",
          source: "manual",
        },
      },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      5,
      "managed_runtime_installation_install",
      { runtime: "opencode_acp" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      6,
      "managed_runtime_installation_status",
      { runtime: "opencode_acp" },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      7,
      "managed_runtime_installation_cancel",
      { runtime: "opencode_acp" },
    );
  });

  it("keeps the inspected program path when selecting a saved installation", () => {
    const saved: ManagedRuntimeSavedInstallation = {
      installationId: "runtime-install-opencode-system",
      runtimeBuildId: "runtime-build-opencode-system",
      connectionId: "runtime-connection-opencode-system",
      inspection: {
        runtime: {
          productId: "opencode",
          installationId: "runtime-install-opencode-system",
          adapterId: "opencode-acp-stdio-v1",
        },
        displayName: "OpenCode",
        selectedPath: "/usr/local/bin/opencode",
        canonicalPath: "/opt/homebrew/bin/opencode",
        source: "manual",
        distribution: "system",
        observedVersion: "1.18.30",
        expectedVersion: "1.18.30",
        artifactSha256: "a".repeat(64),
        expectedSha256: null,
        compatible: true,
        launchReferenceAvailable: true,
        activation: "checked_not_active",
        verifiedAt: 1_760_000_000,
      },
    };

    expect(managedRuntimeConnectionSelection(saved)).toEqual({
      installationId: "runtime-install-opencode-system",
      connectionId: "runtime-connection-opencode-system",
      adapterId: "opencode-acp-stdio-v1",
      label: "OpenCode 1.18.30",
      selectedPath: "/usr/local/bin/opencode",
      canonicalPath: "/opt/homebrew/bin/opencode",
    });
  });
});
