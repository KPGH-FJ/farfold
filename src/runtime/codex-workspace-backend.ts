import { codexWorkspaceRoute } from "./codex-workspace-route";
import {
  CodexAcpWorkspaceReader,
  CODEX_ACP_CLOSED_REASON,
} from "./codex-acp-workspace";
import {
  codexConnectionStatus,
  stopCodexConnection,
  readCodexModelCatalog,
  type CodexConnectionStatus,
} from "./codex-connection";
import {
  openHostSession,
  createHostSession,
  type HostSessionBinding,
  type HostPendingInteraction,
} from "./host-shadow";
import {
  submitCodexTurn,
  steerCodexTurn,
  interruptCodexTurn,
  type CodexTurnTarget,
} from "./codex-turn";
import { replyCodexInteraction, type CodexReply } from "./codex-interaction";
import type { CodexAcpScope } from "./codex-acp-contract";
import { requestCodexAcpHistory } from "./codex-acp-content";
import {
  requestCodexAcpTurn,
  type CodexAcpTurnCommand,
} from "./codex-acp-turn";
import { sameCodexAcpScope } from "./codex-acp-workspace";
import {
  requestCodexAcpConfigure,
  discoverCodexAcpConfigure,
  type CodexConfigureCommand,
} from "./codex-acp-configure";
import {
  requestCodexAcpAdmission,
  type CodexAdmissionCommand,
} from "./codex-acp-admission";
import {
  requestCodexAcpSession,
  type CodexSessionCommand,
} from "./codex-acp-session";

export class RetiredCodexView extends Error {
  constructor() {
    super("Codex 视图目标已变化；旧回执不再应用");
  }
}
/** View lifetime only, never native cancellation, completion or admission. */
export class CodexViewLifetime {
  private revision = 0;
  private key = "";
  select(key: string): () => boolean {
    if (key !== this.key) {
      this.key = key;
      ++this.revision;
    }
    const revision = this.revision;
    return () => revision === this.revision;
  }
  retire() {
    ++this.revision;
  }
}
export function codexBindingKey(binding: HostSessionBinding | null): string {
  return JSON.stringify(
    binding && [
      binding.farfoldSessionId,
      binding.runtimeProductId,
      binding.adapterId,
      binding.installationId,
      binding.runtimeBuildId,
      binding.connectionId,
      binding.nativeSessionId,
      binding.workingCopyId,
      binding.workingCopyPath,
    ],
  );
}

/** Mechanical Direct wrappers and typed ACP contracts; ordinary ACP capabilities stay closed. */
export function codexWorkspaceBackend(
  binding: HostSessionBinding | null,
  current: () => boolean,
  native?: { generation: number; activeTurnId: string | null },
  configureScope?: CodexAcpScope | null,
  newSessionWorkspaceId?: string,
) {
  const route = codexWorkspaceRoute(binding);
  const reader = new CodexAcpWorkspaceReader();
  function requireCurrent() {
    if (!current()) throw new RetiredCodexView();
  }
  function direct() {
    requireCurrent();
    if (route !== "direct" || !binding)
      throw new Error(CODEX_ACP_CLOSED_REASON);
    return binding;
  }
  function target(t: CodexTurnTarget) {
    const b = direct();
    if (
      t.farfoldSessionId !== b.farfoldSessionId ||
      t.nativeSessionId !== b.nativeSessionId ||
      !native ||
      t.generation !== native.generation ||
      !Number.isSafeInteger(t.generation) ||
      t.generation < 1
    )
      throw new Error("Codex 操作不属于当前原生会话");
  }
  function connection(s: CodexConnectionStatus) {
    const b = direct();
    if (
      s.installationId !== b.installationId ||
      s.connectionId !== b.connectionId
    )
      throw new Error("Codex 操作不属于当前原始连接");
  }
  async function guard<T>(action: () => Promise<T>): Promise<T> {
    requireCurrent();
    try {
      const result = await action();
      requireCurrent();
      return result;
    } catch (error) {
      requireCurrent();
      throw error;
    }
  }
  function configureTarget(scope: CodexAcpScope) {
    if (
      route !== "acp" ||
      !binding ||
      !configureScope ||
      !sameCodexAcpScope(scope, configureScope) ||
      scope.runtimeProductId !== binding.runtimeProductId ||
      scope.installationId !== binding.installationId ||
      scope.runtimeBuildId !== binding.runtimeBuildId ||
      scope.adapterId !== binding.adapterId ||
      scope.connectionId !== binding.connectionId
    )
      throw new Error("Configure 不属于当前原连接");
  }
  function admissionTarget(scope: CodexAcpScope) {
    if (binding) return configureTarget(scope);
    if (
      route !== "acp" ||
      !newSessionWorkspaceId ||
      !configureScope ||
      !sameCodexAcpScope(scope, configureScope)
    )
      throw new Error("模型选择不属于已核对的新会话上下文");
  }
  return {
    route,
    current,
    unavailableReason:
      route === "unsupported"
        ? "原 Adapter 不受支持；没有替代连接"
        : CODEX_ACP_CLOSED_REASON,
    capabilities: {
      open: route === "direct",
      send: route === "direct",
      reply: route === "direct",
      stop: route === "direct",
      steer: route === "direct",
      configure: route === "direct",
      selectModel: route === "direct",
    },
    read: () =>
      guard(async () => {
        if (route === "direct")
          return {
            kind: "direct" as const,
            status: await codexConnectionStatus(),
          };
        if (route === "acp")
          return { kind: "acp" as const, snapshot: await reader.read(binding) };
        throw new Error("原 Adapter 不受支持；没有替代连接");
      }),
    open: () => guard(() => openHostSession(direct().farfoldSessionId)),
    sessionAcp: (scope: CodexAcpScope, command: CodexSessionCommand) =>
      guard(async () => {
        if (
          route !== "acp" ||
          !configureScope ||
          !sameCodexAcpScope(scope, configureScope)
        )
          throw new Error("Session 不属于当前原连接");
        if (command.action === "open") {
          configureTarget(scope);
          if (command.farfoldSessionId !== binding!.farfoldSessionId)
            throw new Error("Session 不属于原绑定");
        } else if (
          binding ||
          !newSessionWorkspaceId ||
          command.workingCopyId !== newSessionWorkspaceId
        ) {
          throw new Error("新 Session 不属于已选择的工作副本");
        }
        const result = await requestCodexAcpSession(scope, command);
        if (
          binding &&
          (result.nativeThreadId !== binding.nativeSessionId ||
            result.workingCopyId !== binding.workingCopyId)
        )
          throw new Error("Session 回执不属于原绑定");
        return result;
      }),
    // Ordinary UI capability stays false. Host independently rejects before side effects.
    historyAcp: (scope: CodexAcpScope) =>
      guard(() => {
        configureTarget(scope);
        return requestCodexAcpHistory(scope, binding!.farfoldSessionId);
      }),
    turnAcp: (scope: CodexAcpScope, command: CodexAcpTurnCommand) =>
      guard(() => {
        configureTarget(scope);
        if (command.farfoldSessionId !== binding!.farfoldSessionId)
          throw new Error("任务不属于原 Session 绑定");
        return requestCodexAcpTurn(scope, command);
      }),
    discoverConfigureAcp: (scope: CodexAcpScope) =>
      guard(() => {
        configureTarget(scope);
        return discoverCodexAcpConfigure(scope);
      }),
    admissionAcp: (scope: CodexAcpScope, command: CodexAdmissionCommand) =>
      guard(() => {
        admissionTarget(scope);
        return requestCodexAcpAdmission(scope, command);
      }),
    configureAcp: (scope: CodexAcpScope, command: CodexConfigureCommand) =>
      guard(() => {
        configureTarget(scope);
        return requestCodexAcpConfigure(scope, command);
      }),
    create: (input: Parameters<typeof createHostSession>[0]) =>
      guard(() => {
        direct();
        return createHostSession(input);
      }),
    catalog: (status: CodexConnectionStatus) =>
      guard(() => {
        connection(status);
        return readCodexModelCatalog(status);
      }),
    submit: (t: CodexTurnTarget, text: string, mode: "default" | "plan") =>
      guard(() => {
        target(t);
        return submitCodexTurn(t, text, mode);
      }),
    steer: (t: CodexTurnTarget, turnId: string, text: string) =>
      guard(() => {
        target(t);
        if (!turnId || turnId !== native?.activeTurnId)
          throw new Error("原生轮次缺失或已变化");
        return steerCodexTurn(t, turnId, text);
      }),
    interrupt: (t: CodexTurnTarget, turnId: string) =>
      guard(() => {
        target(t);
        if (!turnId || turnId !== native?.activeTurnId)
          throw new Error("原生轮次缺失或已变化");
        return interruptCodexTurn(t, turnId);
      }),
    disconnect: (status: CodexConnectionStatus) =>
      guard(() => {
        connection(status);
        return stopCodexConnection(status);
      }),
    reply: (
      t: CodexTurnTarget,
      pending: HostPendingInteraction,
      answer: CodexReply,
    ) =>
      guard(() => {
        target(t);
        const request = pending.codex;
        if (
          pending.state !== "pending" ||
          pending.runtime.adapterId !== binding!.adapterId ||
          pending.runtime.productId !== binding!.runtimeProductId ||
          pending.runtime.installationId !== binding!.installationId ||
          pending.runtimeGeneration !== t.generation ||
          pending.nativeSessionId !== t.nativeSessionId ||
          !request ||
          request.threadId !== t.nativeSessionId ||
          request.key !== pending.interactionId ||
          request.turnId !== native?.activeTurnId ||
          request.nativeRequest.params.turnId !== request.turnId ||
          request.nativeRequest.params.threadId !== request.threadId ||
          request.nativeRequest.params.itemId !== request.itemId
        )
          throw new Error("Codex 交互不属于当前原始请求");
        return replyCodexInteraction(t, pending.interactionId, answer);
      }),
  };
}
export type CodexWorkspaceBackend = ReturnType<typeof codexWorkspaceBackend>;
