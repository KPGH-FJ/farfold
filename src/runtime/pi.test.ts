import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  PI_RUNTIME_IDENTITY,
  isRuntimeCommandReady,
  discoverRuntime,
  listSessions,
  piRuntimeAdapter,
  pollPiEvents,
  rejectPendingRpc,
  resumableSessionFile,
  sendRpc,
  settleRpcResponse,
  startRuntime,
  runtimeConnectionReadiness,
} from "./pi";

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

describe("Pi runtime start boundary", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("does not send an empty new-session path as a resumable JSONL file", async () => {
    await startRuntime({
      projectPath: "/tmp/project",
      sessionFile: "",
      resumePrevious: false,
      projectTrust: "approve",
    });

    expect(invoke).toHaveBeenCalledWith("runtime_start", {
      options: {
        projectPath: "/tmp/project",
        sessionFile: null,
        resumePrevious: false,
        projectTrust: "approve",
      },
    });
  });

  it("does not resume a transient Pi session path before its JSONL is listed", () => {
    expect(
      resumableSessionFile("/tmp/pi-sessions/new-session.jsonl", []),
    ).toBeNull();
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

  it("keeps a session path once Pi has listed it as resumable", () => {
    expect(
      resumableSessionFile("/tmp/pi-sessions/saved.jsonl", [
        {
          sessionFile: "/tmp/pi-sessions/saved.jsonl",
        },
      ]),
    ).toBe("/tmp/pi-sessions/saved.jsonl");
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
        base: "verified" as const,
        contributesToLifeModel: "verified" as const,
        usesLifeModel: "verified" as const,
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

  it("binds native sessions immutably to Pi without changing native history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        sessionFile: "/tmp/pi-sessions/session.jsonl",
        sessionId: "native-session-1",
        projectPath: "/tmp/project",
        title: "Session",
        updatedAt: 42,
      },
    ]);

    const [session] = await listSessions();

    expect(invoke).toHaveBeenCalledWith("runtime_list_sessions");
    expect(session.binding).toEqual({
      runtime: PI_RUNTIME_IDENTITY,
      connectionId: "pi-local-native-config-v1",
      projectPath: "/tmp/project",
      nativeSessionId: "native-session-1",
    });
    expect(Object.isFrozen(session.binding)).toBe(true);
  });

  it("preserves an unknown Pi RPC event envelope and adds Runtime identity", async () => {
    const payload = { type: "future_pi_event", opaque: { value: 7 } };
    vi.mocked(invoke).mockResolvedValueOnce([
      { generation: 3, kind: "rpc", payload },
    ]);

    const [event] = await pollPiEvents();

    expect(event).toEqual({
      generation: 3,
      kind: "rpc",
      payload,
      runtime: PI_RUNTIME_IDENTITY,
    });
    expect(event.payload).toBe(payload);
  });
});
