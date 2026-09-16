import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexBindingKey,
  codexWorkspaceBackend,
  CodexViewLifetime,
  RetiredCodexView,
} from "./codex-workspace-backend";
import type { HostSessionBinding } from "./host-shadow";
import type { CodexAcpScope } from "./codex-acp-contract";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const ipc = vi.mocked(invoke);

function binding(adapterId: string): HostSessionBinding {
  return {
    farfoldSessionId: "farfold-session",
    runtimeProductId: "codex",
    installationId: "installation",
    runtimeBuildId: "runtime-build",
    adapterId,
    connectionId: "connection",
    projectId: "project",
    projectPath: "/fixture",
    projectName: "fixture",
    workingCopyId: "working-copy",
    workingCopyPath: "/fixture",
    workingCopyKind: "root",
    branchName: null,
    nativeSessionId: "thread",
    nativeLocatorRegistered: true,
    title: "Codex fixture",
    titleSource: "manual",
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    unreviewedChangeCount: 0,
  };
}

beforeEach(() => ipc.mockReset());

describe("Codex workspace backend facade", () => {
  it("keeps Turn capabilities closed and sends only original ACP Host binding", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const scope: CodexAcpScope = {
      runtimeProductId: "codex",
      installationId: acp.installationId,
      runtimeBuildId: acp.runtimeBuildId,
      adapterId: "codex-acp-stdio-v1",
      adapterBuildId: "adapter",
      connectionId: acp.connectionId,
      profileId: "profile",
      generation: 1,
    };
    const backend = codexWorkspaceBackend(acp, () => true, undefined, scope);
    const command = {
      action: "send" as const,
      farfoldSessionId: acp.farfoldSessionId,
      text: "Synthetic",
    };
    expect(backend.capabilities.send).toBe(false);
    expect(backend.capabilities.stop).toBe(false);
    expect(backend.capabilities.reply).toBe(false);
    expect(backend.capabilities.steer).toBe(false);
    await expect(
      backend.turnAcp({ ...scope, generation: 2 }, command),
    ).rejects.toThrow();
    await expect(
      backend.turnAcp(scope, { ...command, farfoldSessionId: "foreign" }),
    ).rejects.toThrow("原 Session");
    await expect(
      codexWorkspaceBackend(
        null,
        () => true,
        undefined,
        scope,
        "working-copy",
      ).turnAcp(scope, command),
    ).rejects.toThrow();
    await expect(
      codexWorkspaceBackend(
        binding("codex-app-server-v1"),
        () => true,
        undefined,
        scope,
      ).turnAcp(scope, command),
    ).rejects.toThrow();
    expect(ipc).not.toHaveBeenCalled();
    const snapshot = {
      scope,
      farfoldSessionId: acp.farfoldSessionId,
      hostTurnId: "host-turn",
      nativeTurnId: "019a0000-0000-7000-8000-000000000001",
      outcome: "started",
    };
    ipc.mockResolvedValueOnce({ kind: "turn", snapshot });
    await expect(backend.turnAcp(scope, command)).resolves.toEqual(snapshot);
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
      input: { action: "turn", scope, command },
    });
  });
  it("retires a late ACP Turn reply without clearing Host work or retrying", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const scope: CodexAcpScope = {
      runtimeProductId: "codex",
      installationId: acp.installationId,
      runtimeBuildId: acp.runtimeBuildId,
      adapterId: "codex-acp-stdio-v1",
      adapterBuildId: "adapter",
      connectionId: acp.connectionId,
      profileId: "profile",
      generation: 1,
    };
    const lifetime = new CodexViewLifetime();
    const backend = codexWorkspaceBackend(
      acp,
      lifetime.select("original"),
      undefined,
      scope,
    );
    let release!: (v: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = backend.turnAcp(scope, {
      action: "send",
      farfoldSessionId: acp.farfoldSessionId,
      text: "Synthetic",
    });
    lifetime.retire();
    release({
      kind: "turn",
      snapshot: {
        scope,
        farfoldSessionId: acp.farfoldSessionId,
        hostTurnId: "host-turn",
        nativeTurnId: "019a0000-0000-7000-8000-000000000001",
        outcome: "started",
      },
    });
    await expect(pending).rejects.toBeInstanceOf(RetiredCodexView);
    expect(ipc).toHaveBeenCalledTimes(1);
  });
  it("opens ACP only by the persisted Host ID and checks the original native binding", async () => {
    const acp = binding("codex-acp-stdio-v1");
    acp.nativeSessionId = "019a0000-0000-7000-8000-000000000001";
    const scope: CodexAcpScope = {
      runtimeProductId: "codex",
      installationId: acp.installationId,
      runtimeBuildId: acp.runtimeBuildId,
      adapterId: "codex-acp-stdio-v1",
      adapterBuildId: "adapter",
      connectionId: acp.connectionId,
      profileId: "profile",
      generation: 1,
    };
    const backend = codexWorkspaceBackend(acp, () => true, undefined, scope);
    await expect(
      backend.sessionAcp(scope, {
        action: "open",
        farfoldSessionId: "foreign",
      }),
    ).rejects.toThrow("原绑定");
    expect(ipc).not.toHaveBeenCalled();
    const snapshot = {
      scope,
      farfoldSessionId: acp.farfoldSessionId,
      workingCopyId: acp.workingCopyId,
      nativeThreadId: acp.nativeSessionId,
      nativeTreeId: "019a0000-0000-7000-8000-000000000002",
      selection: {
        catalogModelId: "picker",
        nativeModel: "native",
        provider: "provider",
        reasoningEffort: "medium",
      },
    };
    ipc.mockResolvedValueOnce({ kind: "session", snapshot });
    await expect(
      backend.sessionAcp(scope, {
        action: "open",
        farfoldSessionId: acp.farfoldSessionId,
      }),
    ).resolves.toEqual(snapshot);
    ipc.mockResolvedValueOnce({
      kind: "session",
      snapshot: { ...snapshot, nativeThreadId: snapshot.nativeTreeId },
    });
    await expect(
      backend.sessionAcp(scope, {
        action: "open",
        farfoldSessionId: acp.farfoldSessionId,
      }),
    ).rejects.toThrow("原绑定");
    expect(ipc).toHaveBeenCalledTimes(2);
    expect(backend.capabilities.open).toBe(false);
  });
  it("keeps Configure UI capability closed while the typed client preserves original scope", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const scope: CodexAcpScope = {
      runtimeProductId: "codex",
      installationId: acp.installationId,
      runtimeBuildId: acp.runtimeBuildId,
      adapterId: "codex-acp-stdio-v1",
      adapterBuildId: "adapter",
      connectionId: acp.connectionId,
      profileId: "profile",
      generation: 3,
    };
    const backend = codexWorkspaceBackend(acp, () => true, undefined, scope);
    expect(backend.capabilities.configure).toBe(false);
    expect(backend.capabilities.selectModel).toBe(false);
    await expect(
      backend.admissionAcp(
        { ...scope, profileId: "foreign" },
        { action: "refresh" },
      ),
    ).rejects.toThrow("不属于当前原连接");
    await expect(
      backend.configureAcp({ ...scope, generation: 4 }, { action: "browser" }),
    ).rejects.toThrow("不属于当前原连接");
    expect(ipc).not.toHaveBeenCalled();
    await expect(
      backend.discoverConfigureAcp({ ...scope, generation: 4 }),
    ).rejects.toThrow("不属于当前原连接");
    expect(ipc).not.toHaveBeenCalled();
    ipc.mockResolvedValueOnce({ kind: "configure" });
    await backend.configureAcp(scope, {
      action: "status",
      operationId: 7,
      loginId: "original-login",
    });
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
      input: {
        action: "configure",
        scope,
        command: {
          action: "status",
          operationId: 7,
          loginId: "original-login",
        },
      },
    });
    await backend.discoverConfigureAcp(scope);
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: { action: "discover_configure", scope },
    });
    await backend.admissionAcp(scope, { action: "refresh" });
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: { action: "admission", scope, command: { action: "refresh" } },
    });
  });
  it("discards a late Configure reply on view retirement without Direct fallback", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const scope: CodexAcpScope = {
      runtimeProductId: "codex",
      installationId: acp.installationId,
      runtimeBuildId: acp.runtimeBuildId,
      adapterId: "codex-acp-stdio-v1",
      adapterBuildId: "adapter",
      connectionId: acp.connectionId,
      profileId: "profile",
      generation: 3,
    };
    const lifetime = new CodexViewLifetime();
    const backend = codexWorkspaceBackend(
      acp,
      lifetime.select("original"),
      undefined,
      scope,
    );
    let release!: (v: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = backend.discoverConfigureAcp(scope);
    lifetime.retire();
    release({ kind: "configure" });
    await expect(pending).rejects.toBeInstanceOf(RetiredCodexView);
    expect(ipc).toHaveBeenCalledTimes(1);
  });
  it("retires every pending result when the selected binding changes", async () => {
    const lifetime = new CodexViewLifetime();
    const direct = binding("codex-app-server");
    const selected = lifetime.select(codexBindingKey(direct));
    const backend = codexWorkspaceBackend(direct, selected, {
      generation: 3,
      activeTurnId: null,
    });
    let release!: (value: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = backend.submit(
      {
        farfoldSessionId: direct.farfoldSessionId,
        nativeSessionId: direct.nativeSessionId,
        generation: 3,
      },
      "fixture",
      "default",
    );
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_turn_submit", {
      input: {
        farfoldSessionId: direct.farfoldSessionId,
        nativeSessionId: direct.nativeSessionId,
        generation: 3,
        text: "fixture",
        mode: "default",
      },
    });

    lifetime.select(codexBindingKey(binding("codex-acp-stdio-v1")));
    release({
      outcome: "accepted",
      hostTurnId: "host-turn",
      nativeTurnId: "native-turn",
    });
    await expect(pending).rejects.toBeInstanceOf(RetiredCodexView);
  });

  it("keeps every ACP operation unavailable without invoking a direct command", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const backend = codexWorkspaceBackend(acp, () => true, {
      generation: 3,
      activeTurnId: "native-turn",
    });
    expect(backend.route).toBe("acp");
    expect(Object.values(backend.capabilities).every((value) => !value)).toBe(
      true,
    );
    await expect(
      backend.submit(
        {
          farfoldSessionId: acp.farfoldSessionId,
          nativeSessionId: acp.nativeSessionId,
          generation: 3,
        },
        "must-not-send",
        "default",
      ),
    ).rejects.toThrow("尚未开放真实登录、模型与任务");
    await expect(backend.open()).rejects.toThrow(
      "尚未开放真实登录、模型与任务",
    );
    expect(ipc).not.toHaveBeenCalled();
  });

  it("rejects stale Direct Session, generation and active Turn identities before IPC", async () => {
    const direct = binding("codex-app-server");
    const backend = codexWorkspaceBackend(direct, () => true, {
      generation: 3,
      activeTurnId: "native-turn",
    });
    await expect(
      backend.submit(
        {
          farfoldSessionId: direct.farfoldSessionId,
          nativeSessionId: "another-thread",
          generation: 3,
        },
        "must-not-send",
        "default",
      ),
    ).rejects.toThrow("不属于当前原生会话");
    await expect(
      backend.interrupt(
        {
          farfoldSessionId: direct.farfoldSessionId,
          nativeSessionId: direct.nativeSessionId,
          generation: 2,
        },
        "native-turn",
      ),
    ).rejects.toThrow("不属于当前原生会话");
    await expect(
      backend.steer(
        {
          farfoldSessionId: direct.farfoldSessionId,
          nativeSessionId: direct.nativeSessionId,
          generation: 3,
        },
        "another-turn",
        "must-not-send",
      ),
    ).rejects.toThrow("原生轮次缺失或已变化");
    expect(ipc).not.toHaveBeenCalled();
  });
});
