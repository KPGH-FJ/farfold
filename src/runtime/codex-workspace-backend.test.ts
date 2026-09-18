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

function scope(): CodexAcpScope {
  return {
    runtimeProductId: "codex",
    installationId: "installation",
    runtimeBuildId: "runtime-build",
    adapterId: "codex-acp-stdio-v1",
    adapterBuildId: "adapter",
    connectionId: "connection",
    profileId: "profile",
    generation: 1,
  };
}

beforeEach(() => ipc.mockReset());

describe("Codex workspace backend facade", () => {
  it("sends only original ACP Host binding for Turn commands", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const s = scope();
    const backend = codexWorkspaceBackend(acp, () => true, undefined, s);
    const command = {
      action: "send" as const,
      farfoldSessionId: acp.farfoldSessionId,
      text: "Synthetic",
    };
    await expect(
      backend.turnAcp({ ...s, generation: 2 }, command),
    ).rejects.toThrow();
    await expect(
      backend.turnAcp(s, { ...command, farfoldSessionId: "foreign" }),
    ).rejects.toThrow("原 Session");
    await expect(
      codexWorkspaceBackend(null, () => true, undefined, s, "working-copy")
        .turnAcp(s, command),
    ).rejects.toThrow();
    await expect(
      codexWorkspaceBackend(
        binding("codex-app-server"),
        () => true,
        undefined,
        s,
      ).turnAcp(s, command),
    ).rejects.toThrow();
    expect(ipc).not.toHaveBeenCalled();
    const snapshot = {
      scope: s,
      farfoldSessionId: acp.farfoldSessionId,
      hostTurnId: "host-turn",
      nativeTurnId: "019a0000-0000-7000-8000-000000000001",
      outcome: "started",
    };
    ipc.mockResolvedValueOnce({ kind: "turn", snapshot });
    await expect(backend.turnAcp(s, command)).resolves.toEqual(snapshot);
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
      input: { action: "turn", scope: s, command },
    });
  });
  it("retires a late ACP Turn reply without clearing Host work or retrying", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const s = scope();
    const lifetime = new CodexViewLifetime();
    const backend = codexWorkspaceBackend(
      acp,
      lifetime.select("original"),
      undefined,
      s,
    );
    let release!: (v: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = backend.turnAcp(s, {
      action: "send",
      farfoldSessionId: acp.farfoldSessionId,
      text: "Synthetic",
    });
    lifetime.retire();
    release({
      kind: "turn",
      snapshot: {
        scope: s,
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
    const s = scope();
    const backend = codexWorkspaceBackend(acp, () => true, undefined, s);
    await expect(
      backend.sessionAcp(s, {
        action: "open",
        farfoldSessionId: "foreign",
      }),
    ).rejects.toThrow("原绑定");
    expect(ipc).not.toHaveBeenCalled();
    const snapshot = {
      scope: s,
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
      backend.sessionAcp(s, {
        action: "open",
        farfoldSessionId: acp.farfoldSessionId,
      }),
    ).resolves.toEqual(snapshot);
    ipc.mockResolvedValueOnce({
      kind: "session",
      snapshot: { ...snapshot, nativeThreadId: snapshot.nativeTreeId },
    });
    await expect(
      backend.sessionAcp(s, {
        action: "open",
        farfoldSessionId: acp.farfoldSessionId,
      }),
    ).rejects.toThrow("原绑定");
    expect(ipc).toHaveBeenCalledTimes(2);
  });
  it("the typed Configure client preserves the original scope", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const s = { ...scope(), generation: 3 };
    const backend = codexWorkspaceBackend(acp, () => true, undefined, s);
    await expect(
      backend.admissionAcp(
        { ...s, profileId: "foreign" },
        { action: "refresh" },
      ),
    ).rejects.toThrow("不属于当前原连接");
    await expect(
      backend.configureAcp({ ...s, generation: 4 }, { action: "browser" }),
    ).rejects.toThrow("不属于当前原连接");
    await expect(
      backend.discoverConfigureAcp({ ...s, generation: 4 }),
    ).rejects.toThrow("不属于当前原连接");
    expect(ipc).not.toHaveBeenCalled();
    ipc.mockResolvedValueOnce({ kind: "configure" });
    await backend.configureAcp(s, {
      action: "status",
      operationId: 7,
      loginId: "original-login",
    });
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
      input: {
        action: "configure",
        scope: s,
        command: {
          action: "status",
          operationId: 7,
          loginId: "original-login",
        },
      },
    });
    await backend.discoverConfigureAcp(s);
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: { action: "discover_configure", scope: s },
    });
    await backend.admissionAcp(s, { action: "refresh" });
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: { action: "admission", scope: s, command: { action: "refresh" } },
    });
  });
  it("discards a late Configure reply on view retirement without Direct fallback", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const s = { ...scope(), generation: 3 };
    const lifetime = new CodexViewLifetime();
    const backend = codexWorkspaceBackend(
      acp,
      lifetime.select("original"),
      undefined,
      s,
    );
    let release!: (v: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = backend.discoverConfigureAcp(s);
    lifetime.retire();
    release({ kind: "configure" });
    await expect(pending).rejects.toBeInstanceOf(RetiredCodexView);
    expect(ipc).toHaveBeenCalledTimes(1);
  });
  it("retires every pending result when the selected binding changes", async () => {
    const lifetime = new CodexViewLifetime();
    const acp = binding("codex-acp-stdio-v1");
    const s = scope();
    const selected = lifetime.select(codexBindingKey(acp));
    const backend = codexWorkspaceBackend(acp, selected, undefined, s);
    let release!: (value: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = backend.turnAcp(s, {
      action: "send",
      farfoldSessionId: acp.farfoldSessionId,
      text: "fixture",
    });
    lifetime.select(codexBindingKey(binding("codex-acp-stdio-v1-other")));
    release({ kind: "turn", snapshot: {} });
    await expect(pending).rejects.toBeInstanceOf(RetiredCodexView);
  });
  it("rejects the retired Direct binding instead of any fallback operation", async () => {
    const direct = binding("codex-app-server");
    const s = scope();
    const backend = codexWorkspaceBackend(direct, () => true, undefined, s);
    expect(backend.route).toBe("unsupported");
    expect(backend.unavailableReason).toContain("不受支持");
    await expect(backend.read()).rejects.toThrow("不受支持");
    await expect(
      backend.connectAcp(direct.installationId, direct.workingCopyId),
    ).rejects.toThrow();
    await expect(backend.stopAcp(s)).rejects.toThrow();
    await expect(backend.turnAcp(s, {
      action: "send",
      farfoldSessionId: direct.farfoldSessionId,
      text: "must-not-send",
    })).rejects.toThrow();
    await expect(
      backend.interactAcp(s, "key", {
        type: "decision",
        decision: "accept",
      }),
    ).rejects.toThrow();
    expect(ipc).not.toHaveBeenCalled();
  });
  it("Connect, Interact and Steer dispatch only the typed production actions", async () => {
    const acp = binding("codex-acp-stdio-v1");
    const s = scope();
    const backend = codexWorkspaceBackend(acp, () => true, undefined, s);
    ipc.mockResolvedValueOnce({ kind: "connected", scope: s });
    await backend.connectAcp(acp.installationId, acp.workingCopyId);
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: {
        action: "connect",
        installationId: acp.installationId,
        workingCopyId: acp.workingCopyId,
      },
    });
    ipc.mockResolvedValueOnce({ kind: "replied" });
    await backend.interactAcp(s, "interaction-key", {
      type: "decision",
      decision: "accept",
    });
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: {
        action: "interact",
        scope: s,
        key: "interaction-key",
        reply: { type: "decision", decision: "accept" },
      },
    });
    const context = {
      farfoldSessionId: acp.farfoldSessionId,
      hostTurnId: "host-turn",
      workingCopyId: acp.workingCopyId,
      thread: {
        nativeThreadId: "019a0000-0000-7000-8000-000000000001",
        nativeSessionId: "019a0000-0000-7000-8000-000000000002",
        cwd: acp.workingCopyPath,
        path: null,
        status: "idle",
        cliVersion: "0.143.0",
        modelProvider: "openai",
      },
    };
    ipc.mockResolvedValueOnce({ kind: "steered" });
    await backend.steerAcp(s, context, "native-turn", "op-1", "follow up");
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: {
        action: "steer",
        scope: s,
        context,
        nativeTurnId: "native-turn",
        operationId: "op-1",
        text: "follow up",
      },
    });
    ipc.mockResolvedValueOnce({ kind: "stopped", scope: s });
    await backend.stopAcp(s);
    expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
      input: { action: "stop", scope: s },
    });
    await expect(
      backend.interactAcp({ ...s, generation: 2 }, "key", {
        type: "decision",
        decision: "accept",
      }),
    ).rejects.toThrow("不属于当前原连接");
    await expect(
      backend.steerAcp({ ...s, generation: 2 }, context, "t", "op", "x"),
    ).rejects.toThrow("不属于当前原连接");
  });
});
