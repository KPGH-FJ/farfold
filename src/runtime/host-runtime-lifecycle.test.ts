import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  stopHostOpenCodeRuntime,
  stopHostPiRuntime,
} from "./host-runtime-lifecycle";

describe("Host managed Runtime lifecycle", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("stops Pi through one product-scoped Host command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "pi",
      status: { running: false, state: "stopped", generation: 4 },
    });

    await expect(stopHostPiRuntime()).resolves.toMatchObject({
      state: "stopped",
    });
    expect(invoke).toHaveBeenCalledWith("host_managed_runtime_stop", {
      input: { runtimeProductId: "pi" },
    });
  });

  it("rejects a mismatched Runtime result", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeProductId: "pi",
      status: { running: false, state: "stopped", generation: 5 },
    });

    await expect(stopHostOpenCodeRuntime()).rejects.toThrow("non-OpenCode");
  });
});
