import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./host-shadow", () => ({
  createHostSession: vi.fn(),
  openHostSession: vi.fn(),
}));
vi.mock("./host-runtime-lifecycle", () => ({
  stopHostPiRuntime: vi.fn(),
  stopHostPiAcpRuntime: vi.fn(),
}));
vi.mock("./pi-acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-acp")>()),
  piAcpStatus: vi.fn(),
}));
vi.mock("./pi", () => ({
  piRuntimeAdapter: { status: vi.fn() },
  PI_RUNTIME_IDENTITY: { installationId: "bundled-pi" },
}));
vi.mock("./opencode", () => ({ OPENCODE_RUNTIME_IDENTITY: {} }));

import {
  createHostSession,
  openHostSession,
  type HostSessionBinding,
  type HostSessionOpenResult,
} from "./host-shadow";
import {
  stopHostPiAcpRuntime,
  stopHostPiRuntime,
} from "./host-runtime-lifecycle";
import { piRuntimeAdapter, type RuntimeStatus } from "./pi";
import { piAcpStatus, type PiAcpStatus } from "./pi-acp";
import { activatePiSession } from "./pi-session-activation";

const binding: HostSessionBinding = {
  farfoldSessionId: "host-1",
  runtimeProductId: "pi",
  installationId: "bundled-pi",
  runtimeBuildId: "pi-0.84.3",
  adapterId: "pi-rpc",
  connectionId: "pi-local",
  projectId: "project-1",
  projectPath: "/project",
  projectName: "project",
  workingCopyId: "wc-1",
  workingCopyPath: "/project",
  workingCopyKind: "root",
  branchName: null,
  nativeSessionId: "native-1",
  nativeLocatorRegistered: true,
  title: "Keep title",
  titleSource: "manual",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
const opened: HostSessionOpenResult = {
  farfoldSessionId: binding.farfoldSessionId,
  runtimeProductId: "pi",
  installationId: binding.installationId,
  nativeSessionId: binding.nativeSessionId,
  runtimeGeneration: 4,
  runtimeReadyAt: 10,
  openedAt: 11,
  navigation: {
    sessionIndex: { schemaVersion: 3, sessions: [binding] },
    restoreState: null,
  },
};
const status: RuntimeStatus = {
  state: "running",
  running: true,
  generation: 4,
  projectPath: "/project",
  sessionDir: "/sessions",
  savedProjectPath: "/project",
  savedSessionFile: "/sessions/native-1.jsonl",
};
const target = { kind: "open" as const, farfoldSessionId: "host-1" };
function effects(running = true) {
  return {
    running,
    projectTrust: "saved" as const,
    phase: vi.fn(),
    applyStatus: vi.fn(() => true),
    beforeStart: vi.fn(async () => {}),
    applyOpened: vi.fn(async () => {}),
  };
}

function acpFixture() {
  const acpBinding = {
    ...binding,
    installationId: "bundled-pi-acp",
    adapterId: "pi-acp-stdio-v1",
    connectionId: "managed-version-connection",
  };
  const result = {
    ...opened,
    installationId: acpBinding.installationId,
    navigation: {
      ...opened.navigation,
      sessionIndex: { schemaVersion: 3, sessions: [acpBinding] },
    },
  };
  const current: PiAcpStatus = {
    running: true,
    generation: 4,
    runtime: {
      productId: "pi",
      installationId: acpBinding.installationId,
      adapterId: acpBinding.adapterId,
    },
    runtimeBuildId: acpBinding.runtimeBuildId,
    runtimeConnectionId: acpBinding.connectionId,
    cwd: "/project",
    nativeSession: {
      version: 1,
      sessionId: binding.nativeSessionId,
      cwd: "/project",
      sessionFile: "/private/native.jsonl",
    },
    configOptions: [],
    managedProvider: null,
    modelSource: null,
    nativeAdmissionReady: false,
    nativeFirstUse: null,
    lastConfirmedModelSource: null,
    configurationState: "confirmed",
    lastError: null,
    droppedEvents: 0,
  };
  vi.mocked(openHostSession).mockResolvedValue(result);
  vi.mocked(createHostSession).mockResolvedValue(result);
  vi.mocked(piAcpStatus).mockResolvedValue(current);
  return { current, result };
}

describe("Pi Session activation through Host", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(stopHostPiRuntime).mockResolvedValue({
      ...status,
      running: false,
      state: "stopped",
      generation: 3,
    });
    vi.mocked(openHostSession).mockResolvedValue(structuredClone(opened));
    vi.mocked(createHostSession).mockResolvedValue(structuredClone(opened));
    vi.mocked(piRuntimeAdapter.status).mockResolvedValue({ ...status });
  });

  it("resumes the requested binding after stop and configuration refresh, then projects verified state", async () => {
    const ui = effects();
    await activatePiSession(target, ui);
    expect(openHostSession).toHaveBeenCalledWith("host-1", {
      runtimeProductId: "pi",
      projectTrust: "saved",
    });
    expect(
      vi.mocked(stopHostPiRuntime).mock.invocationCallOrder[0],
    ).toBeLessThan(ui.beforeStart.mock.invocationCallOrder[0]);
    expect(ui.beforeStart.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(openHostSession).mock.invocationCallOrder[0],
    );
    expect(ui.applyOpened).toHaveBeenCalledWith(opened, "/project");
    expect(createHostSession).not.toHaveBeenCalled();
  });

  it("rejects obsolete RPC creation before stopping or changing configuration", async () => {
    const ui = effects();
    await expect(
      activatePiSession(
        { kind: "create", workingCopyPath: "/project", replaceRunning: true },
        ui,
      ),
    ).rejects.toThrow("ACP");
    expect(stopHostPiRuntime).not.toHaveBeenCalled();
    expect(ui.beforeStart).not.toHaveBeenCalled();
    expect(createHostSession).not.toHaveBeenCalled();
  });

  it("creates a native-provider first-use session through the same ACP Host entry", async () => {
    const { current } = acpFixture();
    const ui = {
      ...effects(false),
      adapterId: "pi-acp-stdio-v1" as const,
      nativeFirstUse: true,
      applyAcpStatus: vi.fn(() => true),
    };
    await activatePiSession(
      { kind: "create", workingCopyPath: "/project", replaceRunning: false },
      ui,
    );
    expect(createHostSession).toHaveBeenCalledWith({
      installationId: "bundled-pi-acp",
      connectionId: "pi-acp-managed-local-v1",
      workingCopyPath: "/project",
      options: {
        runtimeProductId: "pi",
        projectTrust: "saved",
        adapterId: "pi-acp-stdio-v1",
        nativeFirstUse: true,
      },
    });
    expect(ui.applyAcpStatus).toHaveBeenCalledWith(current);
  });

  it("does not stop an already stopped Runtime when resuming", async () => {
    await activatePiSession(target, effects(false));
    expect(stopHostPiRuntime).not.toHaveBeenCalled();
  });

  it("rejects missing binding before stopping or changing configuration", async () => {
    const ui = effects();
    await expect(
      activatePiSession({ kind: "open", farfoldSessionId: "" }, ui),
    ).rejects.toThrow();
    expect(stopHostPiRuntime).not.toHaveBeenCalled();
    expect(ui.beforeStart).not.toHaveBeenCalled();
  });

  it.each(["rejected", "still-running", "old-generation"])(
    "never opens or changes configuration after an unconfirmed stop: %s",
    async (failure) => {
      const ui = effects();
      if (failure === "rejected")
        vi.mocked(stopHostPiRuntime).mockRejectedValue(
          new Error("stop failed"),
        );
      if (failure === "still-running")
        vi.mocked(stopHostPiRuntime).mockResolvedValue(status);
      if (failure === "old-generation") ui.applyStatus.mockReturnValue(false);
      await expect(activatePiSession(target, ui)).rejects.toThrow();
      expect(ui.beforeStart).not.toHaveBeenCalled();
      expect(openHostSession).not.toHaveBeenCalled();
      expect(ui.applyOpened).not.toHaveBeenCalled();
    },
  );

  it("keeps the existing presentation on an open rejection and never falls back to creating", async () => {
    vi.mocked(openHostSession).mockRejectedValue(
      new Error("native Session missing"),
    );
    const ui = effects(false);
    await expect(activatePiSession(target, ui)).rejects.toThrow(
      "native Session missing",
    );
    expect(ui.applyOpened).not.toHaveBeenCalled();
    expect(createHostSession).not.toHaveBeenCalled();
    expect(openHostSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    "runtime",
    "host-id",
    "native-id",
    "installation",
    "missing-binding",
    "path",
    "generation",
    "stopped",
    "late-status",
  ])("does not project mismatched or stale activation: %s", async (failure) => {
    const result = structuredClone(opened);
    const current = { ...status };
    const ui = effects(false);
    if (failure === "runtime") result.runtimeProductId = "opencode";
    if (failure === "host-id") result.farfoldSessionId = "other-host";
    if (failure === "native-id") result.nativeSessionId = "other-native";
    if (failure === "installation")
      result.installationId = "other-installation";
    if (failure === "missing-binding")
      result.navigation.sessionIndex.sessions = [];
    if (failure === "path") current.projectPath = "/other";
    if (failure === "generation") current.generation += 1;
    if (failure === "stopped") {
      current.running = false;
      current.state = "stopped";
    }
    if (failure === "late-status") ui.applyStatus.mockReturnValue(false);
    vi.mocked(openHostSession).mockResolvedValue(result);
    vi.mocked(piRuntimeAdapter.status).mockResolvedValue(current);
    await expect(activatePiSession(target, ui)).rejects.toThrow();
    expect(ui.applyOpened).not.toHaveBeenCalled();
  });

  it("activates ACP through the same Host sequence without reading legacy RPC state or overriding restored Provider", async () => {
    const { current, result } = acpFixture();
    const ui = {
      ...effects(false),
      adapterId: "pi-acp-stdio-v1" as const,
      applyAcpStatus: vi.fn(() => true),
      managedProvider: {
        providerConnectionId: "current-provider",
        providerConfigVersionId: "current-version",
      },
    };
    await activatePiSession(target, ui);
    expect(openHostSession).toHaveBeenCalledWith("host-1", {
      runtimeProductId: "pi",
      projectTrust: "saved",
      adapterId: "pi-acp-stdio-v1",
    });
    expect(ui.applyAcpStatus).toHaveBeenCalledWith(current);
    expect(ui.applyStatus).not.toHaveBeenCalled();
    expect(piRuntimeAdapter.status).not.toHaveBeenCalled();
    expect(ui.applyOpened).toHaveBeenCalledWith(result, "/project");
    expect(createHostSession).not.toHaveBeenCalled();
  });

  it("stops the exact previous ACP connection before opening and keeps both lifecycle results typed", async () => {
    const { current } = acpFixture();
    const runningAcpTarget = {
      farfoldSessionId: "previous-host",
      nativeSessionId: "previous-native",
      runtimeGeneration: 3,
    };
    vi.mocked(stopHostPiAcpRuntime).mockResolvedValue({
      ...current,
      generation: 3,
      running: false,
      nativeSession: null,
    });
    const ui = {
      ...effects(),
      adapterId: "pi-acp-stdio-v1" as const,
      runningAcpTarget,
      applyAcpStatus: vi.fn(() => true),
    };
    await activatePiSession(target, ui);
    expect(stopHostPiAcpRuntime).toHaveBeenCalledWith(runningAcpTarget);
    expect(stopHostPiRuntime).not.toHaveBeenCalled();
    expect(ui.applyAcpStatus).toHaveBeenCalledTimes(2);
  });

  it("validates the managed selection before disconnecting for a new ACP Session", async () => {
    acpFixture();
    const target = {
      kind: "create" as const,
      workingCopyPath: "/project",
      replaceRunning: true,
    };
    const ui = {
      ...effects(),
      adapterId: "pi-acp-stdio-v1" as const,
      applyAcpStatus: vi.fn(() => true),
    };
    await expect(activatePiSession(target, ui)).rejects.toThrow("Provider");
    expect(stopHostPiRuntime).not.toHaveBeenCalled();
    expect(createHostSession).not.toHaveBeenCalled();
    await activatePiSession(target, {
      ...ui,
      running: false,
      managedProvider: {
        providerConnectionId: "provider",
        providerConfigVersionId: "version",
      },
    });
    expect(createHostSession).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "bundled-pi-acp",
        connectionId: "pi-acp-managed-local-v1",
      }),
    );
  });

  it.each(["connection", "build", "native", "adapter", "generation"])(
    "rejects stale ACP open identity: %s",
    async (failure) => {
      const { current } = acpFixture();
      if (failure === "connection") current.runtimeConnectionId = "wrong";
      if (failure === "build") current.runtimeBuildId = "wrong";
      if (failure === "native") current.nativeSession!.sessionId = "wrong";
      if (failure === "adapter") current.runtime!.adapterId = "pi-rpc-jsonl";
      if (failure === "generation") current.generation += 1;
      const ui = {
        ...effects(false),
        adapterId: "pi-acp-stdio-v1" as const,
        applyAcpStatus: vi.fn(() => true),
      };
      await expect(activatePiSession(target, ui)).rejects.toThrow("绑定");
      expect(ui.applyOpened).not.toHaveBeenCalled();
      expect(ui.applyAcpStatus).not.toHaveBeenCalled();
      expect(createHostSession).not.toHaveBeenCalled();
    },
  );
});
