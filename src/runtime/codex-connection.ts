import { invoke } from "@tauri-apps/api/core";

export interface CodexConnectionStatus {
  generation: number | null;
  installationId: string | null;
  connectionId: string | null;
  processRunning: boolean;
  initialized: boolean;
  stateDirectory: string | null;
  account: {
    account:
      | { type: "apiKey" }
      | { type: "chatgpt"; email: string | null; planType: string }
      | { type: "Unsupported" }
      | null;
    requiresOpenaiAuth: boolean;
  } | null;
  loginPhase:
    "waiting" | "confirming" | "failed" | "canceled" | "unknown" | null;
  diagnosticCount: number;
  diagnosticMethods: string[];
  droppedEvents: number;
  error: string | null;
}

export type CodexAccountAction =
  | { type: "browser_login" }
  | { type: "api_key"; key: string }
  | { type: "cancel_login" }
  | { type: "logout" };

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: {
    reasoningEffort: string;
    description: string;
  }[];
  inputModalities: ("text" | "image")[] | null;
}

export interface CodexModelCatalog {
  installationId: string;
  generation: number;
  models: CodexModel[];
}

export function readCodexModelCatalog(
  status: CodexConnectionStatus,
): Promise<CodexModelCatalog> {
  if (
    !status.initialized ||
    !status.installationId ||
    status.generation === null
  )
    return Promise.reject(new Error("请先连接 Codex"));
  return invoke("codex_model_catalog", {
    installationId: status.installationId,
    generation: status.generation,
  });
}

export function catalogMatchesConnection(
  catalog: CodexModelCatalog,
  status: CodexConnectionStatus | null,
): boolean {
  return Boolean(
    status?.initialized &&
    status.processRunning &&
    catalog.installationId === status.installationId &&
    catalog.generation === status.generation,
  );
}

export function codexConnectionStatus(
  refreshAccount = false,
): Promise<CodexConnectionStatus> {
  return invoke("codex_connection_status", { refreshAccount });
}

export function startCodexConnection(
  installationId: string,
): Promise<CodexConnectionStatus> {
  return invoke("codex_connection_start", { installationId });
}

export function stopCodexConnection(
  status: CodexConnectionStatus,
): Promise<CodexConnectionStatus> {
  return invoke("codex_connection_stop", {
    installationId: status.installationId,
    generation: status.generation,
  });
}

export function codexAccountAction(
  status: CodexConnectionStatus,
  action: CodexAccountAction,
): Promise<CodexConnectionStatus> {
  if (!status.installationId || status.generation === null)
    return Promise.reject(new Error("请先连接 Codex"));
  return invoke("codex_account_action", {
    installationId: status.installationId,
    generation: status.generation,
    action,
  });
}

export function resetCodexConnection(installationId: string): Promise<unknown> {
  return invoke("runtime_supervisor_reset", { installationId });
}

export function codexAccountLabel(status: CodexConnectionStatus): string {
  if (!status.initialized) return "连接尚未就绪";
  if (!status.account) return "账号状态尚未确认";
  const account = status.account.account;
  if (!account)
    return status.account.requiresOpenaiAuth
      ? "尚未登录"
      : "当前原生 Provider 不要求 OpenAI 认证；请求尚未验证";
  switch (account.type) {
    case "chatgpt":
      return `已读取 ChatGPT 账号${account.email ? ` · ${account.email}` : ""} · ${account.planType}`;
    case "apiKey":
      return "已配置 API key；尚未验证请求";
    default:
      return "检测到其他原生认证方式；Farfold 当前未接入";
  }
}
