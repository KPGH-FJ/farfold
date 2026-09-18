import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  stopHostOpenCodeAcpRuntime,
  stopHostPiAcpRuntime,
} from "./host-runtime-lifecycle";

describe("Host managed Runtime lifecycle", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("stops a Pi ACP Session through the same Host authority with the exact target", async () => {
    const session = {
      farfoldSessionId: "host",
      nativeSessionId: "native",
      runtimeGeneration: 7,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "pi",
      status: { running: false, nativeSession: null, configOptions: [] },
    });

    await expect(stopHostPiAcpRuntime(session)).resolves.toMatchObject({
      running: false,
    });
    expect(invoke).toHaveBeenCalledWith("host_managed_runtime_stop", {
      input: { runtimeProductId: "pi", session },
    });
  });

  it("stops an idle ACP Session through the same authority without inventing a recovery turn", async () => {
    const session = {
      farfoldSessionId: "host",
      nativeSessionId: "native",
      runtimeGeneration: 7,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "opencode",
      status: { running: false, generation: 8, configOptions: [] },
    });
    await stopHostOpenCodeAcpRuntime(session);
    expect(invoke).toHaveBeenCalledWith("host_managed_runtime_stop", {
      input: { runtimeProductId: "opencode", session },
    });
  });

  it("recovers ACP through the same Host authority with the exact turn token", async () => {
    const recovery = {
      farfoldSessionId: "host",
      nativeSessionId: "native",
      runtimeGeneration: 7,
      turnId: "turn",
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "opencode",
      status: {
        running: false,
        state: "stopped",
        generation: 8,
        configOptions: [],
      },
    });
    await expect(stopHostOpenCodeAcpRuntime(recovery)).resolves.toMatchObject({
      generation: 8,
      running: false,
    });
    expect(invoke).toHaveBeenCalledWith("host_managed_runtime_stop", {
      input: { runtimeProductId: "opencode", recovery },
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "opencode",
      status: { projectPath: null },
    });
    await expect(stopHostOpenCodeAcpRuntime(recovery)).rejects.toThrow(
      "non-ACP",
    );
  });
});
