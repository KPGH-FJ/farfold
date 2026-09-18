import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  requestCodexAcpSession,
  type CodexSessionCommand,
  type CodexSessionReceipt,
} from "./codex-acp-session";
import {
  codexWorkspaceBackend,
  CodexViewLifetime,
  RetiredCodexView,
} from "./codex-workspace-backend";
import type { CodexAcpScope } from "./codex-acp-contract";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const ipc = vi.mocked(invoke);
const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "install",
  runtimeBuildId: "build",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "adapter",
  connectionId: "conn",
  profileId: "profile",
  generation: 1,
};
const choice = {
  observationScope: scope,
  epoch: 2,
  catalogHash: "a".repeat(64),
  selection: {
    catalogModelId: "picker",
    nativeModel: "native",
    provider: "provider",
    reasoningEffort: "medium",
  },
};
const command: CodexSessionCommand = {
  action: "start",
  workingCopyId: "work",
  choice,
};
const receipt: CodexSessionReceipt = {
  scope,
  farfoldSessionId: "session",
  workingCopyId: "work",
  nativeThreadId: "019a0000-0000-7000-8000-000000000001",
  nativeTreeId: "019a0000-0000-7000-8000-000000000002",
  selection: choice.selection,
};
beforeEach(() => ipc.mockReset());

it("unbound admission requires the selected workspace and exact context without opening capabilities", async () => {
  const unselected = codexWorkspaceBackend(null, () => true, undefined, scope);
  await expect(
    unselected.admissionAcp(scope, { action: "refresh" }),
  ).rejects.toThrow("上下文");
  expect(ipc).not.toHaveBeenCalled();
  const selected = codexWorkspaceBackend(
    null,
    () => true,
    undefined,
    scope,
    "work",
  );
  await expect(
    selected.admissionAcp({ ...scope, generation: 2 }, { action: "refresh" }),
  ).rejects.toThrow("上下文");
  expect(ipc).not.toHaveBeenCalled();
  ipc.mockResolvedValueOnce({ kind: "admission" });
  await selected.admissionAcp(scope, { action: "refresh" });
  expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
    input: { action: "admission", scope, command: { action: "refresh" } },
  });
});

it("uses the unique closed Host command with explicit choice and no free cwd", async () => {
  ipc.mockResolvedValue({ kind: "session", snapshot: receipt });
  expect(await requestCodexAcpSession(scope, command)).toEqual(receipt);
  expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
    input: { action: "session", scope, command },
  });
});
it("rejects malformed or foreign scope/workspace/choice receipts without retry", async () => {
  for (const snapshot of [
    { ...receipt, scope: { ...scope, generation: 2 } },
    { ...receipt, workingCopyId: "foreign" },
    { ...receipt, nativeTreeId: "bad" },
    { ...receipt, selection: { ...receipt.selection, provider: "foreign" } },
    { ...receipt, cwd: "/private" },
  ]) {
    ipc.mockResolvedValueOnce({ kind: "session", snapshot });
    await expect(requestCodexAcpSession(scope, command)).rejects.toThrow(
      "会话身份未确认",
    );
  }
  expect(ipc).toHaveBeenCalledTimes(5);
  ipc.mockRejectedValueOnce(new Error("SECRET raw error"));
  await expect(requestCodexAcpSession(scope, command)).rejects.toThrow(
    "不会自动重试",
  );
  expect(ipc).toHaveBeenCalledTimes(6);
});
it("keeps ordinary capability closed and rejects unselected workspace before IPC", async () => {
  const closed = codexWorkspaceBackend(null, () => true, undefined, scope);
  await expect(closed.sessionAcp(scope, command)).rejects.toThrow("工作副本");
  const selected = codexWorkspaceBackend(
    null,
    () => true,
    undefined,
    scope,
    "work",
  );
  await expect(
    selected.sessionAcp({ ...scope, generation: 2 }, command),
  ).rejects.toThrow("原连接");
  await expect(
    selected.sessionAcp(scope, { action: "open", farfoldSessionId: "other" }),
  ).rejects.toThrow("原连接");
  expect(ipc).not.toHaveBeenCalled();
});
it("discards late Session result on view retirement without creating a replacement", async () => {
  const lifetime = new CodexViewLifetime();
  const backend = codexWorkspaceBackend(
    null,
    lifetime.select("original"),
    undefined,
    scope,
    "work",
  );
  let release!: (value: unknown) => void;
  ipc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = backend.sessionAcp(scope, command);
  lifetime.retire();
  release({ kind: "session", snapshot: receipt });
  await expect(pending).rejects.toBeInstanceOf(RetiredCodexView);
  expect(ipc).toHaveBeenCalledTimes(1);
});
it("open accepts only the original Host ID and exposes no override contract", async () => {
  ipc.mockResolvedValueOnce({ kind: "session", snapshot: receipt });
  await expect(
    requestCodexAcpSession(scope, {
      action: "open",
      farfoldSessionId: "foreign",
    }),
  ).rejects.toThrow("会话身份未确认");
  const bad = {
    ...command,
    choice: { ...choice, observationScope: { ...scope, profileId: "foreign" } },
  };
  await expect(requestCodexAcpSession(scope, bad)).rejects.toThrow(
    "会话身份未确认",
  );
  expect(ipc).toHaveBeenCalledTimes(1);
});
