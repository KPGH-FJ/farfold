import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  OPENCODE_RUNTIME_IDENTITY,
  openCodeProviderConnectionId,
  openCodeCredentialRevisionFingerprint,
  canReuseOpenCodeSession,
  abortOpenCodeTurn,
  discoverOpenCodeRuntime,
  openCodeRuntimeReadiness,
  submitOpenCodeTurn,
  respondToOpenCodePermission,
  openCodeRecoveryTarget,
} from "./opencode";

describe("OpenCode lifecycle host", () => {
  it("finds recovery only for the selected installation and generation", async () => {
    vi.mocked(invoke).mockResolvedValue({
      activeTurns: [
        {
          runtimeProductId: "opencode",
          installationId: "managed",
          farfoldSessionId: "s",
          nativeSessionId: "native",
          runtimeGeneration: 8,
          turnId: "t",
        },
      ],
    });
    await expect(openCodeRecoveryTarget("s", 8, "other")).resolves.toBeNull();
    await expect(openCodeRecoveryTarget("s", 7, "managed")).resolves.toBeNull();
    await expect(openCodeRecoveryTarget("s", 8, "managed")).resolves.toEqual({
      farfoldSessionId: "s",
      nativeSessionId: "native",
      runtimeGeneration: 8,
      turnId: "t",
    });
    vi.mocked(invoke).mockReset();
  });
  it("reopens the retained binding after a crash instead of only focusing it", () => {
    expect(
      canReuseOpenCodeSession(
        { state: "running", running: true },
        "s1",
        "s1",
        false,
      ),
    ).toBe(true);
    for (const state of ["stopped", "starting", "stopping"] as const) {
      expect(
        canReuseOpenCodeSession({ state, running: false }, "s1", "s1", false),
      ).toBe(false);
    }
    expect(
      canReuseOpenCodeSession(
        { state: "running", running: true },
        "s1",
        "s2",
        false,
      ),
    ).toBe(false);
    expect(
      canReuseOpenCodeSession(
        { state: "running", running: true },
        "s1",
        "s1",
        true,
      ),
    ).toBe(false);
  });
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

  it("derives stable Host Provider connection IDs without leaking raw unsafe characters", () => {
    expect(openCodeProviderConnectionId("zai")).toBe("opencode-provider-zai");
    expect(openCodeProviderConnectionId("local/openai")).toBe(
      "opencode-provider-local_openai",
    );
  });

  it("derives credential revision fingerprints from operation identity without raw secrets", () => {
    expect(
      openCodeCredentialRevisionFingerprint("save_api_key", "run/one value"),
    ).toBe("credential:save_api_key:run_one_value");
    expect(openCodeCredentialRevisionFingerprint("remove", "run-one")).toBe(
      "credential:remove:run-one",
    );
    expect(
      openCodeCredentialRevisionFingerprint("save_api_key", "run-one"),
    ).not.toBe(openCodeCredentialRevisionFingerprint("remove", "run-one"));
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
        base: "supported" as const,
        contributesToLifeModel: "supported" as const,
        usesLifeModel: "supported" as const,
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

  it("passes the Host Provider binding only when the caller supplies it", async () => {
    await submitOpenCodeTurn({
      farfoldSessionId: "farfold-1",
      nativeSessionId: "ses_1",
      providerId: "zai",
      modelId: "glm-4.5-air",
      providerConnectionId: "opencode-provider-zai",
      providerConfigVersionId: "provider-version-abc",
      text: "Hello",
    });

    expect(invoke).toHaveBeenCalledWith("host_opencode_turn_submit", {
      input: {
        farfoldSessionId: "farfold-1",
        nativeSessionId: "ses_1",
        providerId: "zai",
        modelId: "glm-4.5-air",
        providerConnectionId: "opencode-provider-zai",
        providerConfigVersionId: "provider-version-abc",
        text: "Hello",
      },
    });
  });
});
