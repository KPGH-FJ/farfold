import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodexInteractionPanel } from "../components/CodexInteractionPanel";
import {
  closedCodexAcpWorkspace,
  type CodexAcpWorkspaceSnapshot,
} from "./codex-acp-workspace";
import type { CodexAcpScope } from "./codex-acp-contract";
import { codexConversation } from "./codex-conversation";
import {
  codexAcpObservedEvent,
  codexWorkspaceView,
  type CodexAcpInteraction,
} from "./codex-workspace-view";
import type {
  HostPendingInteraction,
  HostRoutedEvent,
  HostSessionBinding,
} from "./host-shadow";

const binding: HostSessionBinding = {
  farfoldSessionId: "farfold-session",
  runtimeProductId: "codex",
  installationId: "installation",
  runtimeBuildId: "runtime-build",
  adapterId: "codex-acp-stdio-v1",
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

const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: binding.installationId,
  runtimeBuildId: binding.runtimeBuildId,
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "adapter-build",
  connectionId: binding.connectionId,
  profileId: "profile",
  generation: 3,
};

const context = {
  farfoldSessionId: binding.farfoldSessionId,
  hostTurnId: "host-turn",
  workingCopyId: binding.workingCopyId,
  thread: {
    nativeThreadId: binding.nativeSessionId,
    nativeSessionId: "tree",
    cwd: binding.workingCopyPath,
    path: null,
    status: "idle",
    cliVersion: "0.143.0",
    modelProvider: "openai",
  },
};

function snapshot(): CodexAcpWorkspaceSnapshot {
  return {
    ...closedCodexAcpWorkspace(),
    target: {
      farfoldSessionId: binding.farfoldSessionId,
      runtime: {
        productId: "codex",
        installationId: binding.installationId,
        runtimeBuildId: binding.runtimeBuildId,
        adapterId: binding.adapterId,
        connectionId: binding.connectionId,
      },
      workingCopyId: binding.workingCopyId,
      cwd: binding.workingCopyPath,
      nativeThreadId: binding.nativeSessionId,
      nativeTreeId: "tree",
    },
    scope,
    connectionState: "connected" as const,
    admission: null,
    activeTurn: {
      context,
      nativeTurnId: "native-turn",
      stopRequested: false,
    },
  };
}

function interaction(): HostPendingInteraction {
  const request = {
    key: "interaction",
    threadId: binding.nativeSessionId,
    turnId: "native-turn",
    itemId: "item",
    method: "item/commandExecution/requestApproval",
    decisions: ["accept", "decline"],
    questions: [],
    nativeRequest: {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: binding.nativeSessionId,
        turnId: "native-turn",
        itemId: "item",
        command: "SECRET_COMMAND_SHOULD_NOT_REACH_CLOSED_VIEW",
        cwd: "/private/secret-path",
        reason: "secret-reason",
      },
    },
  };
  const codexAcp: CodexAcpInteraction = {
    scope,
    context,
    nativeTurnId: "native-turn",
    nativeMode: "default",
    request,
    fileChanges: null,
  };
  return {
    runtime: {
      productId: "codex",
      installationId: binding.installationId,
      adapterId: binding.adapterId,
    },
    runtimeGeneration: scope.generation,
    interactionId: request.key,
    nativeSessionId: binding.nativeSessionId,
    kind: "codex_native",
    codexAcp,
    state: "pending",
  };
}

describe("Codex workspace view facade", () => {
  it("keeps ACP interaction identity but removes raw request content from the closed view", () => {
    const view = codexWorkspaceView({
      binding,
      opened: null,
      status: null,
      conversation: codexConversation(),
      acp: snapshot(),
      pending: [interaction()],
      observed: [],
    });

    expect(view.route).toBe("acp");
    expect(view.interactions).toHaveLength(1);
    expect(Object.values(view.capabilities).every((value) => !value)).toBe(
      true,
    );
    const projected = view.interactions[0];
    expect(projected.request.key).toBe("interaction");
    expect(projected.request.nativeRequest).toEqual({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread",
        turnId: "native-turn",
        itemId: "item",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("SECRET_COMMAND");
    expect(JSON.stringify(projected)).not.toContain("secret-path");
    expect(JSON.stringify(projected)).not.toContain("secret-reason");

    const html = renderToStaticMarkup(
      createElement(CodexInteractionPanel, {
        interaction: projected,
        turns: [],
        enabled: false,
        onReply: async () => undefined,
      }),
    );
    expect(html).toContain('aria-label="Codex 审批"');
    expect(html).toContain("原生操作详情不完整");
    expect(html).not.toContain("SECRET_COMMAND");
    expect(html.match(/<button disabled=""/g)?.length).toBeGreaterThan(0);

    const filePending = interaction();
    filePending.codexAcp!.request.method = "item/fileChange/requestApproval";
    filePending.codexAcp!.request.nativeRequest.method =
      "item/fileChange/requestApproval";
    filePending.codexAcp!.fileChanges = [
      {
        path: "/private/SECRET_FILE_PATH",
        kind: { type: "update", move_path: null },
        diff: "SECRET_FILE_DIFF",
      },
    ];
    const fileView = codexWorkspaceView({
      binding,
      opened: null,
      status: null,
      conversation: codexConversation(),
      acp: snapshot(),
      pending: [filePending],
      observed: [],
    });
    expect(JSON.stringify(fileView.interactions)).not.toContain(
      "SECRET_FILE_PATH",
    );
    expect(JSON.stringify(fileView.interactions)).not.toContain(
      "SECRET_FILE_DIFF",
    );
  });

  it("keeps the existing Direct interaction payload unchanged", () => {
    const directBinding = { ...binding, adapterId: "codex-app-server" };
    const directPending = interaction();
    directPending.runtime.adapterId = "codex-app-server";
    directPending.codex = directPending.codexAcp!.request;
    directPending.codexAcp = undefined;
    const conversation = codexConversation();
    const view = codexWorkspaceView({
      binding: directBinding,
      opened: {
        farfoldSessionId: directBinding.farfoldSessionId,
        runtimeProductId: "codex",
        installationId: directBinding.installationId,
        nativeSessionId: directBinding.nativeSessionId,
        runtimeGeneration: scope.generation,
        runtimeReadyAt: 1,
        openedAt: 1,
        navigation: {
          sessionIndex: { schemaVersion: 1, sessions: [directBinding] },
          restoreState: null,
        },
      },
      status: null,
      conversation,
      acp: null,
      pending: [directPending],
      observed: [],
    });
    expect(view.route).toBe("direct");
    expect(view.transcript).toBe(conversation);
    expect(view.interactions).toHaveLength(1);
    expect(view.interactions[0].pending).toBe(directPending);
    expect(JSON.stringify(view.interactions[0])).toContain(
      "SECRET_COMMAND_SHOULD_NOT_REACH_CLOSED_VIEW",
    );
  });

  it("accepts only the exact ACP scope, context and native Turn event", () => {
    const s = snapshot();
    const event: HostRoutedEvent = {
      streamId: "stream",
      sequence: 9,
      runtime: {
        productId: "codex",
        installationId: binding.installationId,
        adapterId: binding.adapterId,
      },
      runtimeBuildId: binding.runtimeBuildId,
      connectionId: binding.connectionId,
      runtimeGeneration: scope.generation,
      kind: "acp",
      preservation: "native",
      receivedAtMs: 1,
      nativeEnvelope: {
        generation: scope.generation,
        kind: "acp",
        payload: {
          method: "_codex/turn/event",
          params: {
            scope,
            turn: { context, nativeTurnId: "native-turn", kind: "delta" },
          },
        },
      },
    };
    expect(codexAcpObservedEvent(event, s)).toEqual({
      sequence: 9,
      hostTurnId: "host-turn",
      nativeTurnId: "native-turn",
      kind: "delta",
    });
    expect(
      codexAcpObservedEvent(
        { ...event, connectionId: "another-connection" },
        s,
      ),
    ).toBeNull();
    expect(
      codexAcpObservedEvent(
        {
          ...event,
          nativeEnvelope: {
            generation: scope.generation,
            kind: "acp",
            payload: {
              method: "_codex/turn/event",
              params: {
                scope,
                turn: {
                  context: { ...context, hostTurnId: "another-turn" },
                  nativeTurnId: "native-turn",
                  kind: "delta",
                },
              },
            },
          },
        },
        s,
      ),
    ).toBeNull();
  });
});
