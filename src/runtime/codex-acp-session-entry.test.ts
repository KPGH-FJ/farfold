import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  activateCodexSessionReceipt as activateWithGuard,
  readCodexSessionContext,
} from "./codex-acp-session-entry";
import { closedCodexAcpWorkspace } from "./codex-acp-workspace";
import { replaceHostNavigation, type HostSessionBinding } from "./host-shadow";
import type { CodexSessionReceipt } from "./codex-acp-session";
import type { CodexAcpScope } from "./codex-acp-contract";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("./host-shadow", () => ({ replaceHostNavigation: vi.fn() }));
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
const selection = {
  catalogModelId: "picker",
  nativeModel: "native",
  provider: "provider",
  reasoningEffort: "medium",
};
const receipt: CodexSessionReceipt = {
  scope,
  farfoldSessionId: "session",
  workingCopyId: "work",
  nativeThreadId: "019a0000-0000-7000-8000-000000000001",
  nativeTreeId: "019a0000-0000-7000-8000-000000000002",
  selection,
};
const context = {
  scope,
  projectId: "project",
  workingCopyId: "work",
  cwd: "/fixture",
  navigationExpectation: {
    kind: "present" as const,
    lastProjectId: null,
    lastSessionId: null,
    updatedAt: 5,
  },
};
const expectedNavigation = { kind: "absent" } as const;
const activateCodexSessionReceipt = (
  r: CodexSessionReceipt,
  current: () => boolean,
) => activateWithGuard(r, current, expectedNavigation);
const binding: HostSessionBinding = {
  farfoldSessionId: "session",
  runtimeProductId: "codex",
  installationId: "install",
  runtimeBuildId: "build",
  adapterId: scope.adapterId,
  connectionId: "conn",
  projectId: "project",
  projectPath: "/fixture",
  projectName: "Fixture",
  workingCopyId: "work",
  workingCopyPath: "/fixture",
  workingCopyKind: "root",
  branchName: null,
  nativeSessionId: receipt.nativeThreadId,
  nativeLocatorRegistered: true,
  title: "Fixture",
  titleSource: "native",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
const navigation = () => ({
  sessionIndex: { schemaVersion: 15, sessions: [{ ...binding }] },
  restoreState: null,
});
const focused = () => ({
  kind: "focused",
  scope,
  farfoldSessionId: "session",
  navigation: {
    ...navigation(),
    restoreState: {
      lastProjectId: "project",
      lastSessionId: "session",
      updatedAt: 6,
    },
  },
});
const snapshot = () => ({
  ...closedCodexAcpWorkspace(),
  scope,
  connectionState: "connected",
  target: {
    farfoldSessionId: "session",
    runtime: {
      productId: "codex",
      installationId: "install",
      runtimeBuildId: "build",
      adapterId: scope.adapterId,
      connectionId: "conn",
    },
    workingCopyId: "work",
    cwd: "/fixture",
    nativeThreadId: receipt.nativeThreadId,
    nativeTreeId: receipt.nativeTreeId,
  },
  admission: {
    scope,
    epoch: 1,
    account: { kind: "apiKey", requiresOpenaiAuth: true },
    catalog: null,
    catalogHash: null,
    selection,
    actual: {
      ...selection,
      nativeThreadId: receipt.nativeThreadId,
      nativeSessionId: receipt.nativeTreeId,
    },
  },
});
beforeEach(() => {
  ipc.mockReset();
  vi.mocked(replaceHostNavigation).mockReset();
  let focusCommitted = false;
  ipc.mockImplementation(async (name) => {
    if (name === "host_codex_acp_session_context")
      return focusCommitted
        ? {
            ...context,
            navigationExpectation: {
              kind: "present",
              ...focused().navigation.restoreState,
            },
          }
        : context;
    if (name === "host_navigation_snapshot") return navigation();
    if (name === "host_codex_acp_operation") {
      focusCommitted = true;
      return focused();
    }
    if (name === "host_codex_acp_workspace") return snapshot();
    throw new Error("Unexpected native mutation");
  });
});
it("reads exact selected installation/workspace, rejects scope drift and raw errors", async () => {
  const input = {
    action: "start" as const,
    installationId: "install",
    runtimeBuildId: "build",
    workingCopyId: "work",
  };
  expect(await readCodexSessionContext(input)).toEqual(context);
  expect(ipc).toHaveBeenCalledExactlyOnceWith(
    "host_codex_acp_session_context",
    { input },
  );
  for (const changed of [
    { ...context, scope: { ...scope, installationId: "foreign" } },
    { ...context, workingCopyId: "other" },
    { ...context, scope: { ...scope, generation: 0 } },
    { ...context, auth: "private" },
  ]) {
    ipc.mockResolvedValueOnce(changed);
    await expect(readCodexSessionContext(input)).rejects.toThrow(
      "不会自动重试",
    );
  }
  ipc.mockRejectedValueOnce(new Error("SECRET"));
  await expect(readCodexSessionContext(input)).rejects.not.toThrow("SECRET");
});
it("activates only a re-read shared binding and tree/actual without a second native operation", async () => {
  expect(await activateCodexSessionReceipt(receipt, () => true)).toEqual(
    binding,
  );
  expect(ipc.mock.calls.map((c) => c[0])).toEqual([
    "host_codex_acp_session_context",
    "host_navigation_snapshot",
    "host_codex_acp_workspace",
    "host_codex_acp_operation",
    "host_codex_acp_session_context",
  ]);
  expect(ipc).toHaveBeenNthCalledWith(4, "host_codex_acp_operation", {
    input: { action: "focus", receipt, expectedNavigation },
  });
  expect(replaceHostNavigation).toHaveBeenCalledExactlyOnceWith(
    focused().navigation,
  );
});
it("rejects foreign, missing, archived and duplicate persisted bindings before focus", async () => {
  for (const sessions of [
    [],
    [{ ...binding, nativeSessionId: "foreign" }],
    [{ ...binding, projectId: "foreign" }],
    [{ ...binding, archivedAt: 2 }],
    [binding, binding],
  ]) {
    ipc.mockClear();
    ipc.mockResolvedValueOnce(context).mockResolvedValueOnce({
      sessionIndex: { schemaVersion: 15, sessions },
      restoreState: null,
    });
    await expect(
      activateCodexSessionReceipt(receipt, () => true),
    ).rejects.toThrow();
    expect(
      ipc.mock.calls.some((c) => c[0] === "host_codex_acp_operation"),
    ).toBe(false);
  }
});
it("generation/tree/model mismatch cannot activate or invoke native open", async () => {
  ipc.mockResolvedValueOnce({ ...context, scope: { ...scope, generation: 2 } });
  await expect(
    activateCodexSessionReceipt(receipt, () => true),
  ).rejects.toThrow();
  for (const changed of [
    { ...snapshot(), target: { ...snapshot().target, nativeTreeId: "other" } },
    {
      ...snapshot(),
      admission: {
        ...snapshot().admission,
        actual: { ...snapshot().admission.actual, provider: "other" },
      },
    },
  ]) {
    ipc.mockClear();
    ipc
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce(navigation())
      .mockResolvedValueOnce(changed);
    await expect(
      activateCodexSessionReceipt(receipt, () => true),
    ).rejects.toThrow();
    expect(
      ipc.mock.calls.some((c) => c[0] === "host_codex_acp_operation"),
    ).toBe(false);
  }
});
it("retired read never focuses, and late focus receipts do not return activation", async () => {
  let current = true;
  ipc.mockImplementationOnce(async () => {
    current = false;
    return context;
  });
  await expect(
    activateCodexSessionReceipt(receipt, () => current),
  ).rejects.toThrow();
  expect(ipc).toHaveBeenCalledTimes(1);
  ipc.mockClear();
  current = true;
  ipc
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(navigation())
    .mockResolvedValueOnce(snapshot())
    .mockImplementationOnce(async () => {
      current = false;
      return navigation();
    });
  await expect(
    activateCodexSessionReceipt(receipt, () => current),
  ).rejects.toThrow();
  expect(ipc).toHaveBeenCalledTimes(4);
});
it("focus result must still contain original binding", async () => {
  ipc
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(navigation())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({
      ...focused(),
      navigation: {
        sessionIndex: { schemaVersion: 15, sessions: [] },
        restoreState: null,
      },
    });
  await expect(
    activateCodexSessionReceipt(receipt, () => true),
  ).rejects.toThrow();
});

it("generation drift during shared focus cannot return activation", async () => {
  ipc
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(navigation())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(focused())
    .mockResolvedValueOnce({ ...context, scope: { ...scope, generation: 2 } });
  await expect(
    activateCodexSessionReceipt(receipt, () => true),
  ).rejects.toThrow();
  expect(ipc).toHaveBeenCalledTimes(5);
});

it("Host guard conflict rejects without refresh of the original token or unguarded focus", async () => {
  ipc
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(navigation())
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(new Error("SECRET conflict"));
  await expect(
    activateCodexSessionReceipt(receipt, () => true),
  ).rejects.toThrow("不会自动重试");
  expect(ipc).toHaveBeenCalledTimes(4);
  expect(ipc).toHaveBeenLastCalledWith("host_codex_acp_operation", {
    input: { action: "focus", receipt, expectedNavigation },
  });
});

it("guarded focus reply must report the matching committed navigation", async () => {
  ipc
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(navigation())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ ...focused(), navigation: navigation() });
  await expect(
    activateCodexSessionReceipt(receipt, () => true),
  ).rejects.toThrow();
  expect(ipc).toHaveBeenCalledTimes(4);
});

it.each([
  { lastSessionId: "other", updatedAt: 7 },
  { lastSessionId: "session", updatedAt: 7 },
])(
  "does not apply A after final raw read observes $lastSessionId at $updatedAt",
  async (next) => {
    ipc
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce(navigation())
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(focused())
      .mockResolvedValueOnce({
        ...context,
        navigationExpectation: {
          kind: "present",
          lastProjectId: "project",
          ...next,
        },
      });
    await expect(
      activateCodexSessionReceipt(receipt, () => true),
    ).rejects.toThrow();
    expect(replaceHostNavigation).not.toHaveBeenCalled();
    expect(ipc).toHaveBeenCalledTimes(5);
    expect(
      ipc.mock.calls.filter((c) => c[0] === "host_codex_acp_operation"),
    ).toEqual([
      [
        "host_codex_acp_operation",
        { input: { action: "focus", receipt, expectedNavigation } },
      ],
    ]);
  },
);
