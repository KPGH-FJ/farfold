import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  CodexAcpWorkspaceReader,
  closedCodexAcpWorkspace,
  codexAcpWorkspaceLabel,
  type CodexAcpWorkspaceSnapshot,
} from "./codex-acp-workspace";
import { codexWorkspaceRoute } from "./codex-workspace-route";
import type { HostSessionBinding } from "./host-shadow";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const ipc = vi.mocked(invoke);
const binding = {
  farfoldSessionId: "host-session",
  runtimeProductId: "codex",
  adapterId: "codex-acp-stdio-v1",
  installationId: "installation",
  runtimeBuildId: "runtime-build",
  connectionId: "connection",
  workingCopyId: "working-copy",
  workingCopyPath: "/fixture",
  nativeSessionId: "thread",
} as HostSessionBinding;
function observed(): CodexAcpWorkspaceSnapshot {
  const scope = {
    runtimeProductId: "codex",
    adapterId: "codex-acp-stdio-v1",
    installationId: "installation",
    runtimeBuildId: "runtime-build",
    adapterBuildId: "adapter-build",
    connectionId: "connection",
    profileId: "profile",
    generation: 1,
  } as const;
  return {
    ...closedCodexAcpWorkspace(),
    target: {
      farfoldSessionId: binding.farfoldSessionId,
      runtime: {
        productId: "codex",
        adapterId: binding.adapterId,
        installationId: binding.installationId,
        runtimeBuildId: binding.runtimeBuildId,
        connectionId: binding.connectionId,
      },
      workingCopyId: binding.workingCopyId,
      cwd: binding.workingCopyPath,
      nativeThreadId: "thread",
      nativeTreeId: "tree",
    },
    scope,
    connectionState: "connected",
    admission: {
      scope,
      epoch: 1,
      account: { kind: "chatgpt", requiresOpenaiAuth: true },
      catalog: [],
      catalogHash: "hash",
      selection: null,
      actual: null,
    },
  };
}
beforeEach(() => ipc.mockReset());
describe("Codex ordinary workspace closed facade", () => {
  it("routes only by persisted adapter; retired Direct bindings are unsupported", async () => {
    expect(codexWorkspaceRoute(null)).toBe("acp");
    expect(codexWorkspaceRoute(binding)).toBe("acp");
    expect(
      codexWorkspaceRoute({ ...binding, adapterId: "codex-app-server" }),
    ).toBe("unsupported");
    expect(codexWorkspaceRoute({ ...binding, adapterId: "unknown" })).toBe(
      "unsupported",
    );
    expect(codexWorkspaceRoute({ ...binding, runtimeProductId: "pi" })).toBe(
      "unsupported",
    );
    await expect(
      new CodexAcpWorkspaceReader().read({
        ...binding,
        adapterId: "codex-app-server",
      }),
    ).rejects.toThrow();
    expect(ipc).not.toHaveBeenCalled();
    ipc.mockResolvedValueOnce(closedCodexAcpWorkspace());
    await new CodexAcpWorkspaceReader().read(null);
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_workspace", {
      farfoldSessionId: null,
    });
  });
  it("reflects Host-issued capabilities for the exact scope", async () => {
    const s = observed();
    s.capabilities.submitTurn = true;
    s.capabilities.authenticate = true;
    ipc.mockResolvedValueOnce(s);
    const result = await new CodexAcpWorkspaceReader().read(binding);
    expect(result!.capabilities.submitTurn).toBe(true);
    expect(result!.capabilities.authenticate).toBe(true);
  });
  it("rejects wrong Session, original thread/tree, worktree and full admission scope", async () => {
    const mutations = [
      (s: CodexAcpWorkspaceSnapshot) => {
        s.target!.farfoldSessionId = "other";
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.target!.nativeThreadId = "other";
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.target!.workingCopyId = "other";
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.target!.cwd = "/other";
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.target!.runtime.adapterId = "codex-app-server";
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.admission!.scope = { ...s.scope!, profileId: "other" };
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.admission!.scope = { ...s.scope!, generation: 2 };
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.admission!.scope = { ...s.scope!, adapterBuildId: "other" };
      },
      (s: CodexAcpWorkspaceSnapshot) => {
        s.admission!.actual = {
          catalogModelId: "model-id",
          nativeModel: "model",
          provider: "provider",
          reasoningEffort: "medium",
          nativeThreadId: "thread",
          nativeSessionId: "other-tree",
        };
      },
    ];
    for (const mutate of mutations) {
      const s = observed();
      mutate(s);
      ipc.mockResolvedValueOnce(s);
      await expect(new CodexAcpWorkspaceReader().read(binding)).rejects.toThrow(
        "状态无法核对",
      );
    }
  });
  it("drops late success and failure after Session switch or unmount; no fallback", async () => {
    let release!: (value: CodexAcpWorkspaceSnapshot) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const reader = new CodexAcpWorkspaceReader();
    const pending = reader.read(binding);
    ipc.mockResolvedValueOnce(closedCodexAcpWorkspace());
    expect((await reader.read(null))?.target).toBeNull();
    release(observed());
    expect(await pending).toBeNull();
    let reject!: (error: Error) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const disposed = reader.read(binding);
    reader.cancel();
    reject(new Error("synthetic-secret-never-render"));
    expect(await disposed).toBeNull();
    expect(
      ipc.mock.calls.every(([name]) => name === "host_codex_acp_workspace"),
    ).toBe(true);
  });
  it("does not reflect temporary secrets from unknown IPC errors", async () => {
    ipc.mockRejectedValueOnce(new Error("synthetic-secret-never-render"));
    await expect(new CodexAcpWorkspaceReader().read(binding)).rejects.toThrow(
      "未尝试旧连接或原生操作",
    );
  });
  it("separates login completion, account, catalog, selection, actual and production readiness", () => {
    const s = observed();
    expect(codexAcpWorkspaceLabel(s)).toContain("尚未显式选择");
    s.configurePhase = "confirming";
    expect(codexAcpWorkspaceLabel(s)).toContain("不等于账号已确认");
    s.configurePhase = "confirmed";
    s.admission = null;
    expect(codexAcpWorkspaceLabel(s)).toContain("账号尚未确认");
    s.admission = observed().admission;
    s.admission!.catalog = null;
    expect(codexAcpWorkspaceLabel(s)).toContain("目录未知或已失效");
    s.admission!.catalog = [];
    s.admission!.selection = {
      catalogModelId: "id",
      nativeModel: "model",
      provider: "provider",
      reasoningEffort: "medium",
    };
    expect(codexAcpWorkspaceLabel(s)).toContain("实际模型尚未确认");
    s.admission!.actual = {
      ...s.admission!.selection,
      nativeThreadId: "thread",
      nativeSessionId: "tree",
    };
    expect(codexAcpWorkspaceLabel(s)).toContain("已确认");
    s.connectionState = "unknown";
    expect(codexAcpWorkspaceLabel(s)).toContain("结果未知");
  });
  it("retains original active Turn identity and never interprets Stop request as terminal", async () => {
    const s = observed();
    s.activeTurn = {
      context: {
        farfoldSessionId: binding.farfoldSessionId,
        hostTurnId: "host-turn",
        workingCopyId: binding.workingCopyId,
        thread: {
          nativeThreadId: "thread",
          nativeSessionId: "tree",
          cwd: "/fixture",
          path: null,
          status: "idle",
          cliVersion: "0.143.0",
          modelProvider: "provider",
        },
      },
      nativeTurnId: "native-turn",
      stopRequested: true,
    };
    expect(codexAcpWorkspaceLabel(s)).toContain("尚未确认停止");
    ipc.mockResolvedValueOnce(s);
    expect(
      (await new CodexAcpWorkspaceReader().read(binding))?.activeTurn?.context
        .hostTurnId,
    ).toBe("host-turn");
    s.activeTurn.context.thread.nativeSessionId = "other-tree";
    ipc.mockResolvedValueOnce(s);
    await expect(new CodexAcpWorkspaceReader().read(binding)).rejects.toThrow();
  });
});
