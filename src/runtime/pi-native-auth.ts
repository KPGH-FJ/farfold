import { invoke } from "@tauri-apps/api/core";
import type { AuthPrompt, AuthNotice, AuthType } from "./capabilities";
import { readPiAcpWorkspace, type PiAcpTarget } from "./pi-acp";

export interface PiNativeAuthCatalog {
  providers: {
    id: string;
    name: string;
    credentialType: AuthType | null;
    methods: { type: AuthType; name: string }[];
  }[];
}

export interface PiNativeAuthSnapshot {
  version: 1;
  sessionId: string;
  flowId: string;
  providerId: string;
  authType: AuthType;
  operation: "login" | "logout";
  state:
    "running" | "cancelling" | "succeeded" | "cancelled" | "failed" | "unknown";
  credentialState: "not_attempted" | "committed" | "unknown";
  refreshState: "not_attempted" | "confirmed" | "unknown";
  prompt: { id: string; value: AuthPrompt } | null;
  notice: AuthNotice | null;
}

export type PiNativeAuthCommand =
  | {
      action: "start";
      providerId: string;
      authType: AuthType;
      operation?: "login" | "logout";
    }
  | { action: "status" | "cancel"; flowId: string }
  | { action: "reply"; flowId: string; promptId: string; value: string };

export async function readPiNativeAuthCatalog(
  target: PiAcpTarget,
): Promise<PiNativeAuthCatalog> {
  return (await readPiAcpWorkspace({
    ...target,
    section: "auth_catalog",
  })) as PiNativeAuthCatalog;
}

export function requestPiNativeAuth(
  target: PiAcpTarget,
  command: PiNativeAuthCommand,
): Promise<PiNativeAuthSnapshot> {
  return invoke("pi_acp_native_auth", { input: { ...target, command } });
}

export function piNativeAuthPending(
  flow: PiNativeAuthSnapshot | null,
): boolean {
  return flow?.state === "running" || flow?.state === "cancelling";
}

export function piNativeAuthLabel(flow: PiNativeAuthSnapshot): string {
  if (flow.operation === "logout") {
    if (flow.state === "succeeded") return "已移除保存的凭据，Pi 已刷新";
    if (flow.state === "running") return "等待 Pi 退出登录";
    if (flow.state === "cancelling") return "正在取消退出登录";
    if (flow.state === "cancelled") return "已取消退出，未进入凭据提交";
    if (flow.state === "failed") return "退出登录未开始";
    return flow.credentialState === "committed"
      ? "保存的凭据已移除，刷新未确认；请断开并恢复当前对话"
      : "凭据是否已移除尚未确认；请断开并恢复当前对话";
  }
  if (flow.state === "succeeded")
    return "凭据已保存，Pi 已刷新；尚未验证模型请求";
  if (flow.state === "cancelling") return "正在取消登录";
  if (flow.state === "cancelled") return "登录已取消，未进入凭据提交";
  if (flow.state === "failed") return "登录未开始，请检查原生认证配置";
  if (flow.state === "unknown")
    return flow.credentialState === "committed"
      ? "凭据已保存，刷新未确认；请断开并恢复当前对话"
      : "凭据是否改变尚未确认；请断开并恢复当前对话";
  return "等待 Pi 完成登录";
}
