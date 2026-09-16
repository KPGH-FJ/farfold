// Fixed Codex 0.143.0 native types, verified from generated protocol.
// Ephemeral UI contract. The registered Host operation remains production-closed.
export const CODEX_ACP_NATIVE_LOGIN_TYPES = [
  "apiKey",
  "chatgpt",
  "chatgptDeviceCode",
] as const;

export interface CodexAcpScope {
  runtimeProductId: "codex";
  installationId: string;
  runtimeBuildId: string;
  adapterId: "codex-acp-stdio-v1";
  adapterBuildId: string;
  connectionId: string;
  profileId: string;
  generation: number;
}

export type CodexNativeLoginRequest =
  | { type: "apiKey"; apiKey: string }
  | { type: "chatgpt"; codexStreamlinedLogin?: boolean }
  | { type: "chatgptDeviceCode" };

export type CodexNativeLoginReply =
  | { type: "apiKey" }
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };

export type CodexNativeAccountOperation =
  | { method: "account/read"; params: { refreshToken: false } }
  | { method: "account/login/start"; params: CodexNativeLoginRequest }
  | { method: "account/login/cancel"; params: { loginId: string } }
  | { method: "account/logout"; params: Record<string, never> };

export type CodexAcpLoginView =
  | { phase: "unavailable"; reason: string }
  | {
      phase: "waiting";
      scope: CodexAcpScope;
      reply: Exclude<CodexNativeLoginReply, { type: "apiKey" }>;
    }
  | {
      phase: "confirming" | "canceled" | "failed" | "unknown";
      scope: CodexAcpScope;
      loginId: string | null;
    };

export function codexAcpLoginAvailability(): CodexAcpLoginView {
  return {
    phase: "unavailable",
    reason: "Codex ACP 认证合同已接线；生产入口仍关闭。",
  };
}

// Ephemeral Host Configure result, never a session event or task-ready receipt.
export interface CodexAcpConfigureSnapshot {
  scope: CodexAcpScope;
  operationId: number;
  phase:
    | "starting"
    | "waiting"
    | "confirming"
    | "canceling"
    | "confirmed"
    | "canceled"
    | "failed"
    | "unknown";
  loginId: string | null;
  credentialState: "not_attempted" | "committed" | "removed" | "unknown";
  accountState: "unconfirmed" | "unauthenticated" | "api_key" | "chatgpt";
  payload:
    | { type: "browser"; authUrl: string }
    | { type: "device"; verificationUrl: string; userCode: string }
    | null;
}

export function codexAcpConfigureLabel(
  snapshot: CodexAcpConfigureSnapshot,
): string {
  if (snapshot.phase === "unknown") return "配置结果未知；请断开连接后核对";
  if (snapshot.phase === "canceled") return "已取消；凭据状态仍需核对";
  if (snapshot.phase === "failed") return "配置失败";
  if (snapshot.phase === "waiting") return "等待原认证操作；尚未确认账号";
  if (snapshot.phase === "canceling") return "取消请求处理中；尚未确认取消";
  if (snapshot.phase !== "confirmed") return "配置中；尚未确认账号";
  if (snapshot.accountState === "unconfirmed") return "账号状态待确认";
  if (snapshot.accountState === "unauthenticated") return "需要登录";
  return "上次配置已完成并读取账号；模型请求与任务能力尚未验证";
}

// A completion never confirms account availability. The same original target
// must still be read by the future adapter-owned account operation.
export function acceptsCodexLoginCompletion(
  current: CodexAcpLoginView,
  completion: {
    scope: CodexAcpScope;
    loginId: string | null;
    success: boolean;
  },
): boolean {
  if (current.phase !== "waiting") return false;
  const keys: (keyof CodexAcpScope)[] = [
    "runtimeProductId",
    "installationId",
    "runtimeBuildId",
    "adapterId",
    "adapterBuildId",
    "connectionId",
    "profileId",
    "generation",
  ];
  return (
    keys.every((key) => current.scope[key] === completion.scope[key]) &&
    current.reply.loginId === completion.loginId
  );
}
