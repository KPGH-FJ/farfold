import { invoke } from "@tauri-apps/api/core";
import type {
  CodexAcpScope,
  CodexAcpConfigureSnapshot,
} from "./codex-acp-contract";
import type { HostSessionBinding } from "./host-shadow";
import { codexWorkspaceRoute } from "./codex-workspace-route";

export const CODEX_ACP_CLOSED_REASON =
  "Codex ACP 需要自有环境连接；连接未建立或结果未知时不会创建、打开或恢复会话。";

export interface CodexAcpSelection {
  catalogModelId: string;
  nativeModel: string;
  provider: string;
  reasoningEffort: string;
}
export interface CodexAcpWorkspaceSnapshot {
  target: {
    farfoldSessionId: string;
    runtime: {
      productId: string;
      installationId: string;
      runtimeBuildId: string;
      adapterId: string;
      connectionId: string;
    };
    workingCopyId: string;
    cwd: string;
    nativeThreadId: string;
    nativeTreeId: string;
  } | null;
  scope: CodexAcpScope | null;
  connectionState: "disconnected" | "connected" | "unknown";
  capabilities: Record<
    | "createSession"
    | "openSession"
    | "authenticate"
    | "selectModel"
    | "submitTurn"
    | "replyInteraction"
    | "steer"
    | "interrupt",
    boolean
  >;
  blockedReason: string;
  configurePhase: CodexAcpConfigureSnapshot["phase"] | null;
  admission: {
    scope: CodexAcpScope;
    epoch: number;
    account: { kind: string; requiresOpenaiAuth: boolean } | null;
    catalog:
      | {
          id: string;
          model: string;
          displayName: string;
          description: string;
          hidden: boolean;
          isDefault: boolean;
          supportedReasoningEfforts: {
            reasoningEffort: string;
            description: string;
          }[];
          defaultReasoningEffort: string;
          inputModalities: string[];
        }[]
      | null;
    catalogHash: string | null;
    selection: CodexAcpSelection | null;
    actual:
      | (CodexAcpSelection & {
          nativeThreadId: string;
          nativeSessionId: string;
        })
      | null;
  } | null;
  activeTurn: {
    context: {
      farfoldSessionId: string;
      hostTurnId: string;
      workingCopyId: string;
      thread: {
        nativeThreadId: string;
        nativeSessionId: string;
        cwd: string;
        path: string | null;
        status: string;
        cliVersion: string;
        modelProvider: string;
      };
    };
    nativeTurnId: string | null;
    stopRequested: boolean;
  } | null;
}

export const closedCodexAcpWorkspace = (): CodexAcpWorkspaceSnapshot => ({
  target: null,
  scope: null,
  connectionState: "disconnected",
  capabilities: {
    createSession: false,
    openSession: false,
    authenticate: false,
    selectModel: false,
    submitTurn: false,
    replyInteraction: false,
    steer: false,
    interrupt: false,
  },
  blockedReason: CODEX_ACP_CLOSED_REASON,
  configurePhase: null,
  admission: null,
  activeTurn: null,
});

export function sameCodexAcpScope(a: CodexAcpScope, b: CodexAcpScope): boolean {
  return (
    (Object.keys(a) as (keyof CodexAcpScope)[]).length === 8 &&
    (
      [
        "runtimeProductId",
        "installationId",
        "runtimeBuildId",
        "adapterId",
        "adapterBuildId",
        "connectionId",
        "profileId",
        "generation",
      ] as const
    ).every((key) => a[key] === b[key])
  );
}

/** Cached model observation never grants production sendability. */
export function codexAcpWorkspaceLabel(s: CodexAcpWorkspaceSnapshot): string {
  if (s.connectionState === "unknown")
    return "连接或任务结果未知；需核对原会话";
  if (s.connectionState === "disconnected") return "Codex ACP 未连接";
  if (s.configurePhase === "unknown") return "配置结果未知；不能继续任务";
  if (s.activeTurn)
    return s.activeTurn.stopRequested
      ? "已请求停止，等待原生终态；尚未确认停止"
      : s.activeTurn.nativeTurnId
        ? "原生轮次活动中"
        : "提交结果待确认";
  if (
    ["starting", "waiting", "confirming", "canceling"].includes(
      s.configurePhase ?? "",
    )
  )
    return "配置中；登录完成不等于账号已确认";
  const a = s.admission;
  if (!a?.account) return "账号尚未确认；需要登录后重新核对";
  if (!a.catalog || !a.catalogHash) return "模型目录未知或已失效";
  if (!a.selection) return "已读取账号；尚未显式选择模型";
  if (!a.actual) return "已选择模型；原生会话实际模型尚未确认";
  return "上次原生模型已确认；发送前仍须核对当前能力与连接";
}

export function codexAcpSnapshotMatches(
  s: CodexAcpWorkspaceSnapshot,
  b: HostSessionBinding | null,
): boolean {
  // An unbound page may observe the live unbound connection's scope and
  // admission; a bound Session's connection never leaks into it.
  if (!b) {
    if (s.target || s.activeTurn) return false;
    if (!s.scope) return !s.admission && s.connectionState === "disconnected";
    return !s.admission || sameCodexAcpScope(s.admission.scope, s.scope);
  }
  const t = s.target;
  if (
    !t ||
    codexWorkspaceRoute(b) !== "acp" ||
    t.farfoldSessionId !== b.farfoldSessionId ||
    t.nativeThreadId !== b.nativeSessionId ||
    t.workingCopyId !== b.workingCopyId ||
    t.cwd !== b.workingCopyPath ||
    !t.nativeTreeId ||
    t.runtime.productId !== b.runtimeProductId ||
    t.runtime.installationId !== b.installationId ||
    t.runtime.runtimeBuildId !== b.runtimeBuildId ||
    t.runtime.adapterId !== b.adapterId ||
    t.runtime.connectionId !== b.connectionId
  )
    return false;
  const scope = s.scope;
  if (!scope)
    return (
      s.connectionState === "disconnected" && !s.admission && !s.activeTurn
    );
  if (
    scope.runtimeProductId !== b.runtimeProductId ||
    scope.adapterId !== b.adapterId ||
    scope.installationId !== b.installationId ||
    scope.runtimeBuildId !== b.runtimeBuildId ||
    scope.connectionId !== b.connectionId ||
    !scope.adapterBuildId ||
    !scope.profileId ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  )
    return false;
  if (s.admission && !sameCodexAcpScope(s.admission.scope, scope)) return false;
  const actual = s.admission?.actual;
  if (
    actual &&
    (actual.nativeThreadId !== t.nativeThreadId ||
      actual.nativeSessionId !== t.nativeTreeId)
  )
    return false;
  const turn = s.activeTurn?.context;
  return (
    !turn ||
    (turn.farfoldSessionId === t.farfoldSessionId &&
      turn.workingCopyId === t.workingCopyId &&
      turn.thread.cwd === t.cwd &&
      turn.thread.nativeThreadId === t.nativeThreadId &&
      turn.thread.nativeSessionId === t.nativeTreeId &&
      !!turn.hostTurnId)
  );
}

/** One latest read per mounted view. No retry, fallback, native open or secret persistence. */
export class CodexAcpWorkspaceReader {
  private revision = 0;
  cancel() {
    ++this.revision;
  }
  async read(
    binding: HostSessionBinding | null,
  ): Promise<CodexAcpWorkspaceSnapshot | null> {
    const revision = ++this.revision;
    if (codexWorkspaceRoute(binding) !== "acp")
      throw new Error("非 ACP 原绑定，拒绝状态读取");
    try {
      const snapshot = await invoke<CodexAcpWorkspaceSnapshot>(
        "host_codex_acp_workspace",
        {
          farfoldSessionId: binding?.farfoldSessionId ?? null,
        },
      );
      if (revision !== this.revision) return null;
      if (!codexAcpSnapshotMatches(snapshot, binding))
        throw new Error("scope mismatch");
      // Host-issued capabilities are the current truth for this exact scope.
      return snapshot;
    } catch {
      if (revision !== this.revision) return null;
      // Do not reflect transport errors that might contain provider/auth payloads.
      throw new Error("Codex ACP 状态无法核对；未尝试旧连接或原生操作");
    }
  }
}
