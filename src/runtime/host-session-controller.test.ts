import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

import { invoke } from "@tauri-apps/api/core";
import { createHostOpenCodeSession, createHostPiSession } from "./host-shadow";

describe("Host Session controller commands", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("creates Pi Sessions from a Working Copy without a native locator input", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      farfoldSessionId: "session-1",
      runtimeProductId: "pi",
      installationId: "bundled-pi",
      nativeSessionId: "native-1",
      runtimeGeneration: 4,
      openedAt: 10,
      navigation: {
        sessionIndex: { schemaVersion: 3, sessions: [] },
        restoreState: null,
      },
    });

    await expect(
      createHostPiSession("/tmp/project", "approve"),
    ).resolves.toMatchObject({ farfoldSessionId: "session-1" });
    expect(invoke).toHaveBeenCalledWith("host_pi_session_create", {
      input: { projectPath: "/tmp/project", projectTrust: "approve" },
    });
  });

  it("creates OpenCode Sessions from a Working Copy without a native Session input", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      farfoldSessionId: "session-2",
      runtimeProductId: "opencode",
      installationId: "bundled-opencode",
      nativeSessionId: "ses_native",
      runtimeGeneration: 5,
      openedAt: 11,
      navigation: {
        sessionIndex: { schemaVersion: 3, sessions: [] },
        restoreState: null,
      },
    });

    await expect(
      createHostOpenCodeSession("/tmp/project"),
    ).resolves.toMatchObject({ farfoldSessionId: "session-2" });
    expect(invoke).toHaveBeenCalledWith("host_opencode_session_create", {
      input: { projectPath: "/tmp/project" },
    });
  });
});
