import { describe, expect, it } from "vitest";
import type { HostSessionBinding } from "./host-shadow";
import { sessionStartInput } from "./session-start";
import {
  openCodeAcpTurnProviderBinding,
  openCodeAcpSessionReady,
  openCodePendingPermissionIds,
  openCodePostCreateActivation,
} from "./opencode-session-binding";

function session(adapterId: string): HostSessionBinding {
  return {
    farfoldSessionId: "farfold-1",
    runtimeProductId: "opencode",
    installationId: "opencode-acp-system",
    runtimeBuildId: "opencode-acp-build",
    adapterId,
    connectionId: "opencode-acp-connection",
    projectId: "project-1",
    projectPath: "/tmp/project",
    projectName: "project",
    workingCopyId: "copy-1",
    workingCopyPath: "/tmp/project",
    workingCopyKind: "root",
    branchName: null,
    nativeSessionId: "native-1",
    nativeLocatorRegistered: true,
    title: "OpenCode ACP",
    titleSource: "native",
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 3,
    unreviewedChangeCount: 0,
  };
}

describe("OpenCode post-create activation", () => {
  it("uses the restored Host installation when creating in another working copy", () => {
    const restored = session("opencode-acp-stdio-v1");
    expect(
      sessionStartInput(
        "/tmp/new-worktree",
        { runtimeProductId: "opencode" },
        restored,
      ),
    ).toMatchObject({
      installationId: restored.installationId,
      connectionId: restored.connectionId,
      workingCopyPath: "/tmp/new-worktree",
      options: { adapterId: restored.adapterId },
    });
  });
  it("blocks the composer when an old connection or working copy remains selected", () => {
    const binding = openCodePostCreateActivation(
      session("opencode-acp-stdio-v1"),
    ).binding;
    const status = {
      running: true,
      ready: true,
      sessionId: binding.nativeSessionId,
      runtimeConnectionId: binding.connectionId,
      runtimeBuildId: binding.runtimeBuildId,
      runtime: binding.runtime,
      cwd: binding.projectPath,
    };
    expect(openCodeAcpSessionReady(binding, status, binding.projectPath)).toBe(
      true,
    );
    expect(openCodeAcpSessionReady(binding, status, "/tmp/new-worktree")).toBe(
      false,
    );
    for (const changed of [
      { ready: false },
      { sessionId: "new-session" },
      { runtimeConnectionId: "other-connection" },
      { runtimeBuildId: "other-build" },
      { cwd: "/tmp/old-worktree" },
    ])
      expect(
        openCodeAcpSessionReady(
          binding,
          { ...status, ...changed },
          binding.projectPath,
        ),
      ).toBe(false);
  });
  it("keeps native questions in the current generation's pending interaction list", () => {
    const binding = openCodePostCreateActivation(
      session("opencode-acp-stdio-v1"),
    ).binding;
    const question = {
      runtime: binding.runtime,
      runtimeGeneration: 7,
      interactionId: "question-current",
      nativeSessionId: binding.nativeSessionId,
      kind: "open_code_question" as const,
      state: "pending" as const,
    };
    expect([
      ...openCodePendingPermissionIds(
        [
          question,
          {
            ...question,
            runtimeGeneration: 6,
            interactionId: "question-stale",
          },
        ],
        binding,
        7,
      ),
    ]).toEqual(["question-current"]);
  });

  it("activates ACP state instead of the Server status path for ACP sessions", () => {
    const activation = openCodePostCreateActivation(
      session("opencode-acp-stdio-v1"),
    );
    expect(activation).toMatchObject({
      kind: "acp",
      hostSessionId: "farfold-1",
      nativeSessionId: "native-1",
      binding: {
        farfoldSessionId: "farfold-1",
        nativeSessionId: "native-1",
        runtime: { adapterId: "opencode-acp-stdio-v1" },
      },
    });
  });

  it("uses the active managed ACP session as the only Provider turn binding receipt", () => {
    expect(
      openCodeAcpTurnProviderBinding({
        providerConnectionId: "managed-provider-openai",
        providerConfigVersionId: "config-version-old",
        runtimeProviderId: "acp-config:model",
        runtimeModelId: "model:gpt-old",
      }),
    ).toEqual({
      providerConnectionId: "managed-provider-openai",
      providerConfigVersionId: "config-version-old",
      runtimeProviderId: "acp-config:model",
      runtimeModelId: "model:gpt-old",
    });
  });

  it("does not send a Provider turn binding receipt for native unmanaged ACP config", () => {
    expect(openCodeAcpTurnProviderBinding(null)).toBeNull();
  });

  it("keeps only current active OpenCode permission interactions for the active session", () => {
    const binding = openCodePostCreateActivation(
      session("opencode-acp-stdio-v1"),
    ).binding;

    expect([
      ...openCodePendingPermissionIds(
        [
          {
            runtime: {
              productId: "opencode",
              installationId: "opencode-acp-system",
              adapterId: "opencode-acp-stdio-v1",
            },
            runtimeGeneration: 7,
            interactionId: "permission-current",
            nativeSessionId: "native-1",
            kind: "open_code_permission",
            state: "pending",
          },
          {
            runtime: {
              productId: "opencode",
              installationId: "opencode-acp-system",
              adapterId: "opencode-acp-stdio-v1",
            },
            runtimeGeneration: 6,
            interactionId: "permission-old-generation",
            nativeSessionId: "native-1",
            kind: "open_code_permission",
            state: "pending",
          },
          {
            runtime: {
              productId: "opencode",
              installationId: "opencode-acp-system",
              adapterId: "opencode-acp-stdio-v1",
            },
            runtimeGeneration: 7,
            interactionId: "permission-responding",
            nativeSessionId: "native-1",
            kind: "open_code_permission",
            state: "responding",
          },
          {
            runtime: {
              productId: "opencode",
              installationId: "opencode-acp-system",
              adapterId: "opencode-acp-stdio-v1",
            },
            runtimeGeneration: 7,
            interactionId: "permission-other-session",
            nativeSessionId: "native-other",
            kind: "open_code_permission",
            state: "pending",
          },
        ],
        binding,
        7,
      ),
    ]).toEqual(["permission-current", "permission-responding"]);
  });
});
