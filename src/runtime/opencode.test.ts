import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  OPENCODE_RUNTIME_IDENTITY,
  abortOpenCodeTurn,
  discoverOpenCodeRuntime,
  listOpenCodeSessions,
  openCodeRuntimeReadiness,
  parseOpenCodeNativeSession,
  submitOpenCodeTurn,
  respondToOpenCodePermission,
} from "./opencode";

describe("OpenCode lifecycle host", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("keeps product, installation, and Adapter identities separate", () => {
    expect(OPENCODE_RUNTIME_IDENTITY).toEqual({
      productId: "opencode",
      installationId: "bundled-opencode-1.15.13-arm64",
      adapterId: "opencode-server-http-sse-v1",
    });
    expect(Object.isFrozen(OPENCODE_RUNTIME_IDENTITY)).toBe(true);
  });

  it("discovers only through the OpenCode-specific host command", async () => {
    const descriptor = {
      discovery: {
        identity: OPENCODE_RUNTIME_IDENTITY,
        displayName: "OpenCode",
        version: "1.15.13",
        distribution: "bundled" as const,
        protocol: "opencode-server-http-sse",
      },
      capabilities: {
        runtime: OPENCODE_RUNTIME_IDENTITY,
        base: "verified" as const,
        contributesToLifeModel: "verified" as const,
        usesLifeModel: "verified" as const,
        nativeFeatures: ["tools", "permissions"],
      },
    };
    vi.mocked(invoke).mockResolvedValueOnce(descriptor);

    await expect(discoverOpenCodeRuntime()).resolves.toEqual(descriptor);
    expect(invoke).toHaveBeenCalledWith("opencode_runtime_discover");
  });

  it("keeps process readiness separate from Provider, model, and account", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      runtime: OPENCODE_RUNTIME_IDENTITY,
      phase: "running",
      commandChannel: "ready",
      provider: "unknown",
      model: "unknown",
      account: "unknown",
      nativeConfiguration: "runtime_owned",
    });

    await expect(openCodeRuntimeReadiness()).resolves.toMatchObject({
      commandChannel: "ready",
      provider: "unknown",
      model: "unknown",
      account: "unknown",
    });
  });

  it("uses the official prompt, abort, and permission host commands", async () => {
    await submitOpenCodeTurn({
      farfoldSessionId: "farfold-1",
      nativeSessionId: "ses_1",
      providerId: "opencode",
      modelId: "big-pickle",
      text: "Hello",
    });
    await abortOpenCodeTurn({
      farfoldSessionId: "farfold-1",
      nativeSessionId: "ses_1",
    });
    await respondToOpenCodePermission({
      sessionId: "ses_1",
      permissionId: "per_1",
      response: "once",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "host_opencode_turn_submit", {
      input: {
        farfoldSessionId: "farfold-1",
        nativeSessionId: "ses_1",
        providerId: "opencode",
        modelId: "big-pickle",
        text: "Hello",
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "host_opencode_turn_abort", {
      input: {
        farfoldSessionId: "farfold-1",
        nativeSessionId: "ses_1",
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "opencode_permission_respond", {
      input: {
        sessionId: "ses_1",
        permissionId: "per_1",
        response: "once",
      },
    });
  });

  it("parses official native Sessions without treating opaque fields as Farfold state", async () => {
    const session = {
      id: "ses_native",
      directory: "/tmp/project",
      title: "  Native title  ",
      slug: "ignored",
      time: { created: 10, updated: 20 },
    };
    expect(parseOpenCodeNativeSession(session)).toEqual({
      id: "ses_native",
      projectPath: "/tmp/project",
      title: "Native title",
      createdAt: 10,
      updatedAt: 20,
    });
    expect(parseOpenCodeNativeSession({ id: "wrong" })).toBeNull();

    vi.mocked(invoke).mockResolvedValueOnce([session, { malformed: true }]);
    await expect(listOpenCodeSessions()).resolves.toHaveLength(1);
  });
});
