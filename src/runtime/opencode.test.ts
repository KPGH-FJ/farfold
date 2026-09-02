import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  OPENCODE_RUNTIME_IDENTITY,
  abortOpenCodeSession,
  createOpenCodeSession,
  discoverOpenCodeRuntime,
  isCurrentOpenCodeBinding,
  listOpenCodeBindings,
  listOpenCodeSessions,
  openCodeRuntimeReadiness,
  parseOpenCodeNativeSession,
  pollOpenCodeEvents,
  promptOpenCode,
  rememberOpenCodeBinding,
  respondToOpenCodePermission,
  startOpenCodeRuntime,
  stopOpenCodeRuntime,
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

  it("starts and stops without routing through the Pi commands", async () => {
    await startOpenCodeRuntime({ projectPath: "/tmp/project" });
    await stopOpenCodeRuntime();

    expect(invoke).toHaveBeenNthCalledWith(1, "opencode_runtime_start", {
      options: { projectPath: "/tmp/project" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "opencode_runtime_stop");
  });

  it("uses the official Session prompt, abort, and permission host commands", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "ses_1",
      directory: "/tmp/project",
      title: "New Session",
      time: { created: 10, updated: 12 },
    });
    await createOpenCodeSession("  New Session  ");
    await promptOpenCode({
      sessionId: "ses_1",
      providerId: "opencode",
      modelId: "big-pickle",
      text: "Hello",
    });
    await abortOpenCodeSession("ses_1");
    await respondToOpenCodePermission({
      sessionId: "ses_1",
      permissionId: "per_1",
      response: "once",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "opencode_session_create", {
      title: "New Session",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "opencode_prompt_async", {
      input: {
        sessionId: "ses_1",
        providerId: "opencode",
        modelId: "big-pickle",
        text: "Hello",
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "opencode_session_abort", {
      sessionId: "ses_1",
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "opencode_permission_respond", {
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

  it("asks the Host to validate and persist a native Session by ID", async () => {
    const binding = {
      runtime: OPENCODE_RUNTIME_IDENTITY,
      connectionId: "opencode-local-native-config-v1",
      nativeSessionId: "ses_native",
      projectPath: "/tmp/project",
      title: "Native title",
      createdAt: 10,
      updatedAt: 20,
    };
    vi.mocked(invoke).mockResolvedValueOnce(binding);
    await expect(
      rememberOpenCodeBinding({
        id: "ses_native",
        projectPath: "/tmp/project",
        title: "Native title",
        createdAt: 10,
        updatedAt: 20,
      }),
    ).resolves.toEqual(binding);
    expect(invoke).toHaveBeenLastCalledWith("opencode_binding_remember", {
      input: {
        nativeSessionId: "ses_native",
      },
    });

    vi.mocked(invoke).mockResolvedValueOnce([binding]);
    const [listed] = await listOpenCodeBindings();
    expect(listed.runtime).toEqual(OPENCODE_RUNTIME_IDENTITY);
    expect(Object.isFrozen(listed.runtime)).toBe(true);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(isCurrentOpenCodeBinding(listed)).toBe(true);
    expect(
      isCurrentOpenCodeBinding({
        ...listed,
        runtime: { ...listed.runtime, installationId: "another-installation" },
      }),
    ).toBe(false);
  });

  it("preserves unknown SSE payloads and adds the immutable Runtime identity", async () => {
    const payload = { type: "future.event", properties: { opaque: 7 } };
    vi.mocked(invoke).mockResolvedValueOnce([
      { generation: 4, kind: "sse", payload },
    ]);

    const [event] = await pollOpenCodeEvents();

    expect(event).toEqual({
      generation: 4,
      kind: "sse",
      payload,
      runtime: OPENCODE_RUNTIME_IDENTITY,
    });
    expect(event.payload).toBe(payload);
  });
});
