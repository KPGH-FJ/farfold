import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  PI_RUNTIME_IDENTITY,
  abortPiTurn,
  isRuntimeCommandReady,
  discoverRuntime,
  piRuntimeAdapter,
  rejectPendingRpc,
  sendRpc,
  submitPiTurn,
  settleRpcResponse,
  runtimeConnectionReadiness,
} from "./pi";

describe("Pi RPC response correlation", () => {
  beforeEach(() => {
    rejectPendingRpc("test reset");
  });

  it("reads large native history through the bounded response channel, not event replay", async () => {
    const response = {
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [{ role: "user", content: "x".repeat(1_100_000) }] },
    };
    vi.mocked(invoke).mockResolvedValueOnce(response);
    await expect(sendRpc({ type: "get_messages" })).resolves.toEqual(response);
    expect(invoke).toHaveBeenLastCalledWith("runtime_history", {
      query: { type: "get_messages" },
    });
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

describe("Pi runtime command boundary", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("does not expose the command channel before get_state is observed for this generation", () => {
    expect(isRuntimeCommandReady({ running: true, generation: 7 }, null)).toBe(
      false,
    );
    expect(isRuntimeCommandReady({ running: true, generation: 7 }, 6)).toBe(
      false,
    );
    expect(isRuntimeCommandReady({ running: true, generation: 7 }, 7)).toBe(
      true,
    );
  });

  it("routes prompt and abort through typed Host Turn commands", async () => {
    const prompt = submitPiTurn({
      farfoldSessionId: "farfold-1",
      nativeSessionId: "native-1",
      command: { type: "prompt", id: "prompt-1", message: "Hello" },
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenNthCalledWith(1, "host_pi_turn_submit", {
      input: {
        farfoldSessionId: "farfold-1",
        nativeSessionId: "native-1",
        command: { type: "prompt", id: "prompt-1", message: "Hello" },
      },
    });
    settleRpcResponse({
      type: "response",
      id: "prompt-1",
      command: "prompt",
      success: true,
    });
    await prompt;

    const abort = abortPiTurn({
      farfoldSessionId: "farfold-1",
      nativeSessionId: "native-1",
    });
    await Promise.resolve();
    const abortInvocation = vi.mocked(invoke).mock.calls[1];
    expect(abortInvocation?.[0]).toBe("host_pi_turn_abort");
    expect(abortInvocation?.[1]).toMatchObject({
      input: {
        farfoldSessionId: "farfold-1",
        nativeSessionId: "native-1",
        command: { type: "abort" },
      },
    });
    const abortId = (
      abortInvocation?.[1] as {
        input: { command: { id: string } };
      }
    ).input.command.id;
    settleRpcResponse({
      type: "response",
      id: abortId,
      command: "abort",
      success: true,
    });
    await abort;
  });
});

describe("Pi Runtime Adapter", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("exposes one stable product, installation, and adapter identity", () => {
    expect(piRuntimeAdapter.identity).toEqual({
      productId: "pi",
      installationId: "bundled-pi",
      adapterId: "pi-rpc-jsonl",
    });
  });

  it("discovers through the neutral host command", async () => {
    const descriptor = {
      discovery: {
        identity: PI_RUNTIME_IDENTITY,
        displayName: "Pi",
        version: "0.84.3",
        distribution: "bundled" as const,
        protocol: "pi-rpc-jsonl",
      },
      capabilities: {
        runtime: PI_RUNTIME_IDENTITY,
        base: "supported" as const,
        contributesToLifeModel: "supported" as const,
        usesLifeModel: "supported" as const,
        nativeFeatures: ["tools"],
      },
    };
    vi.mocked(invoke).mockResolvedValueOnce(descriptor);

    await expect(discoverRuntime()).resolves.toEqual(descriptor);
    expect(invoke).toHaveBeenCalledWith("runtime_discover");
  });

  it("keeps process readiness separate from Provider, model, and account truth", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      state: "running",
      running: true,
      projectPath: "/tmp/project",
      sessionDir: "/tmp/sessions",
      generation: 2,
      savedProjectPath: null,
      savedSessionFile: null,
    });

    await expect(runtimeConnectionReadiness()).resolves.toMatchObject({
      commandChannel: "ready",
      provider: "unknown",
      model: "unknown",
      account: "unknown",
    });
  });
});
