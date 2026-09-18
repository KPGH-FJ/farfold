import { codexWorkspaceRoute } from "./codex-workspace-route";
import {
  CodexAcpWorkspaceReader,
  CODEX_ACP_CLOSED_REASON,
} from "./codex-acp-workspace";
import type { HostSessionBinding } from "./host-shadow";
import type { CodexReply } from "./codex-interaction";
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
import {
  requestCodexAcpConnect,
  requestCodexAcpInteract,
  requestCodexAcpSteer,
  requestCodexAcpStop,
} from "./codex-acp-operations";
import type { CodexAcpContext } from "./codex-workspace-view";

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

/** Typed ACP contracts only; no Direct fallback remains for any binding. */
export function codexWorkspaceBackend(
  binding: HostSessionBinding | null,
  current: () => boolean,
  _native?: { generation: number; activeTurnId: string | null },
  configureScope?: CodexAcpScope | null,
  newSessionWorkspaceId?: string,
) {
  const route = codexWorkspaceRoute(binding);
  const reader = new CodexAcpWorkspaceReader();
  function requireCurrent() {
    if (!current()) throw new RetiredCodexView();
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
    read: () =>
      guard(async () => {
        if (route === "acp")
          return { kind: "acp" as const, snapshot: await reader.read(binding) };
        throw new Error("原 Adapter 不受支持；没有替代连接");
      }),
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
    // First owned launch creates the profile; a persisted profile restores
    // exactly. Connect is unbound: it must not require an existing Session.
    connectAcp: (installationId: string, workingCopyId: string) =>
      guard(() => {
        if (route !== "acp") throw new Error("非 ACP 原绑定，拒绝连接");
        return requestCodexAcpConnect({ installationId, workingCopyId });
      }),
    stopAcp: (scope: CodexAcpScope) =>
      guard(() => {
        configureTarget(scope);
        return requestCodexAcpStop(scope);
      }),
    interactAcp: (scope: CodexAcpScope, key: string, reply: CodexReply) =>
      guard(() => {
        configureTarget(scope);
        return requestCodexAcpInteract(scope, key, reply);
      }),
    steerAcp: (
      scope: CodexAcpScope,
      context: CodexAcpContext,
      nativeTurnId: string,
      operationId: string,
      text: string,
    ) =>
      guard(() => {
        configureTarget(scope);
        return requestCodexAcpSteer(
          scope,
          context,
          nativeTurnId,
          operationId,
          text,
        );
      }),
  };
}
export type CodexWorkspaceBackend = ReturnType<typeof codexWorkspaceBackend>;
