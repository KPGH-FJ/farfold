import type {
  HostRoutedEvent,
  HostSessionBinding,
} from "../../src/runtime/host-shadow";
import { closedCodexAcpWorkspace } from "../../src/runtime/codex-acp-workspace";
import type { AcpHistory } from "../../src/runtime/codex-acp-content";
export const contentBinding: HostSessionBinding = {
  farfoldSessionId: "content-session",
  nativeSessionId: "019a0000-0000-7000-8000-000000000001",
  runtimeProductId: "codex",
  installationId: "install",
  runtimeBuildId: "build",
  adapterId: "codex-acp-stdio-v1",
  connectionId: "connection",
  projectId: "project",
  projectPath: "/fixture",
  projectName: "Fixture",
  workingCopyId: "work",
  workingCopyPath: "/fixture",
  workingCopyKind: "root",
  branchName: null,
  nativeLocatorRegistered: true,
  title: "只读正文",
  titleSource: "native",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
export function contentSnapshot() {
  const s = closedCodexAcpWorkspace();
  s.connectionState = "connected";
  s.scope = {
    runtimeProductId: "codex",
    installationId: "install",
    runtimeBuildId: "build",
    adapterId: "codex-acp-stdio-v1",
    adapterBuildId: "adapter",
    connectionId: "connection",
    profileId: "profile",
    generation: 1,
  };
  s.target = {
    farfoldSessionId: contentBinding.farfoldSessionId,
    runtime: {
      productId: "codex",
      installationId: "install",
      runtimeBuildId: "build",
      adapterId: "codex-acp-stdio-v1",
      connectionId: "connection",
    },
    workingCopyId: "work",
    cwd: "/fixture",
    nativeThreadId: contentBinding.nativeSessionId,
    nativeTreeId: "019a0000-0000-7000-8000-000000000002",
  };
  return s;
}
export const contentNativeTurn = "019a0000-0000-7000-8000-000000000010";
export function contentContext() {
  return {
    farfoldSessionId: contentBinding.farfoldSessionId,
    hostTurnId: "host-turn",
    workingCopyId: "work",
    thread: {
      nativeThreadId: contentBinding.nativeSessionId,
      nativeSessionId: contentSnapshot().target!.nativeTreeId,
      cwd: "/fixture",
      path: null,
      status: "idle",
      cliVersion: "0.143.0",
      modelProvider: "synthetic",
    },
  };
}
export function contentHistory(): AcpHistory {
  return {
    scope: contentSnapshot().scope!,
    farfoldSessionId: contentBinding.farfoldSessionId,
    nativeThreadId: contentBinding.nativeSessionId,
    nativeTreeId: contentSnapshot().target!.nativeTreeId,
    before: {
      streamId: "stream",
      latestSequence: 0,
      oldestAvailable: null,
      droppedTotal: 0,
    },
    turns: [],
  };
}
export function contentEvent(
  sequence: number,
  payload: Record<string, unknown>,
): HostRoutedEvent {
  return {
    streamId: "stream",
    sequence,
    runtime: {
      productId: "codex",
      adapterId: "codex-acp-stdio-v1",
      installationId: "install",
    },
    runtimeBuildId: "build",
    connectionId: "connection",
    runtimeGeneration: 1,
    kind: "acp",
    preservation: "native",
    receivedAtMs: 1,
    nativeEnvelope: {
      generation: 1,
      kind: "acp",
      payload: {
        method: "_codex/turn/event",
        params: {
          scope: contentSnapshot().scope,
          turn: {
            context: contentContext(),
            nativeTurnId: contentNativeTurn,
            ...payload,
          },
        },
      },
    },
  };
}
export function contentBatch(after: number, events: HostRoutedEvent[]) {
  const next = events.at(-1)?.sequence ?? after;
  return {
    streamId: "stream",
    requestedAfter: after,
    oldestAvailable: 1,
    latestSequence: next,
    nextAfter: next,
    hasMore: false,
    gap: null,
    events,
  };
}
