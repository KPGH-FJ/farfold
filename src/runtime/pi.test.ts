import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { rejectPendingRpc, sendRpc, settleRpcResponse } from "./pi";

describe("Pi RPC response correlation", () => {
  beforeEach(() => {
    rejectPendingRpc("test reset");
  });

  it("does not resolve when stdin write alone succeeds", async () => {
    let resolved = false;
    const request = sendRpc({ type: "get_state", id: "state-1" }).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(
      settleRpcResponse({
        type: "response",
        id: "state-1",
        command: "get_state",
        success: true,
        data: {},
      }),
    ).toBe(true);
    await request;
    expect(resolved).toBe(true);
  });

  it("rejects the matching request when Pi reports failure", async () => {
    const request = sendRpc({
      type: "set_model",
      id: "model-1",
      provider: "openai",
      modelId: "gpt-test",
    });
    settleRpcResponse({
      type: "response",
      id: "model-1",
      command: "set_model",
      success: false,
      error: "model unavailable",
    });
    await expect(request).rejects.toThrow("model unavailable");
  });

  it("rejects all requests when the runtime generation ends", async () => {
    const request = sendRpc({ type: "abort", id: "abort-1" });
    rejectPendingRpc("Pi stopped");
    await expect(request).rejects.toThrow("Pi stopped");
  });
});
