import { invoke } from "@tauri-apps/api/core";
import type { RuntimeIdentity } from "./adapter";

export type RuntimeProduct = "pi" | "opencode" | "codex";

interface CapabilitySet<T> {
  base: T;
  contributesToLifeModel: T;
  usesLifeModel: T;
}

export interface RuntimeAuthoritySnapshot {
  runtime: RuntimeIdentity;
  runtimeBuildId: string;
  adapterSupport: CapabilitySet<boolean>;
  installationCompatibility: CapabilitySet<{
    compatible: boolean;
    observedVersion: string | null;
    detail: string | null;
  }>;
  liveReadiness: CapabilitySet<{ ready: boolean; reasonCode: string | null }>;
  retentionCapabilities: RuntimeRetentionCapability[];
}

export function inspectRuntimeCapabilities(
  runtime: string,
): Promise<RuntimeAuthoritySnapshot> {
  return invoke("runtime_capability_snapshot", { runtime });
}

export function runtimeCapabilityRows(
  snapshot: RuntimeAuthoritySnapshot | null,
): string[] {
  if (!snapshot) return ["能力状态尚未取得"];
  const installation = snapshot.installationCompatibility.base;
  const support = snapshot.adapterSupport;
  return [
    installation.compatible
      ? `运行组件已校验 · ${installation.observedVersion}`
      : "运行组件不可用，请检查安装",
    `对话与工具：${support.base ? "已支持" : "未支持"}`,
    `LifeModel 来源：${support.contributesToLifeModel ? "已支持" : "未支持"}`,
    `LifeModel 使用：${support.usesLifeModel ? "已支持" : "未支持"}`,
  ];
}

export type RetentionStatus =
  | "accepted"
  | "partial"
  | "adapter_gap"
  | "version_blocked"
  | "unknown"
  | "out_of_scope";

export interface RuntimeRetentionCapability {
  key:
    | "launch"
    | "task"
    | "intervention"
    | "stop"
    | "interaction"
    | "provider"
    | "resume"
    | "artifacts";
  label: string;
  status: RetentionStatus;
  detail: string;
}

const capabilityStatusLabel: Record<RetentionStatus, string> = {
  accepted: "已验收",
  partial: "部分可用",
  adapter_gap: "适配缺口",
  version_blocked: "版本阻断",
  unknown: "待核验",
  out_of_scope: "暂不支持",
};

const fallbackRetentionCapabilities: Record<
  RuntimeProduct,
  RuntimeRetentionCapability[]
> = {
  pi: [
    {
      key: "launch",
      label: "安装与启动",
      status: "accepted",
      detail: "0.84.3 随包运行；ACP 候选仍需单独核验。",
    },
    {
      key: "task",
      label: "正常任务",
      status: "accepted",
      detail: "RPC 文件任务与流式事件已有安装证据。",
    },
    {
      key: "intervention",
      label: "插话与跟进",
      status: "accepted",
      detail: "保留原生 steer 与 follow-up；ACP 候选不能降级。",
    },
    {
      key: "stop",
      label: "停止",
      status: "accepted",
      detail: "原生 abort 已验收；停止不代表撤销文件修改。",
    },
    {
      key: "interaction",
      label: "权限与提问",
      status: "adapter_gap",
      detail: "Extension UI 已有工程证据；ACP input/editor 候选有缺口。",
    },
    {
      key: "provider",
      label: "Provider 与模型",
      status: "partial",
      detail: "私有模型投影已验证；共享一次配置仍待实现。",
    },
    {
      key: "resume",
      label: "会话恢复",
      status: "accepted",
      detail: "原生 JSONL 身份和冷启动恢复已有安装证据。",
    },
    {
      key: "artifacts",
      label: "成果审阅",
      status: "partial",
      detail: "文件定位可用；完整 diff 与归因仍是后续范围。",
    },
  ],
  opencode: [
    {
      key: "launch",
      label: "安装与启动",
      status: "accepted",
      detail: "1.15.13 随包运行；ACP 固定版本需重新选择。",
    },
    {
      key: "task",
      label: "正常任务",
      status: "accepted",
      detail: "Server 文件任务与流式事件已有安装证据。",
    },
    {
      key: "intervention",
      label: "插话与跟进",
      status: "unknown",
      detail: "不把再次 prompt 直接当作等价即时插话。",
    },
    {
      key: "stop",
      label: "停止",
      status: "version_blocked",
      detail: "固定 1.15.13 ACP service 取消路径返回不支持。",
    },
    {
      key: "interaction",
      label: "权限与提问",
      status: "partial",
      detail: "原生权限已验收；自由文本提问映射未确认。",
    },
    {
      key: "provider",
      label: "Provider 与模型",
      status: "partial",
      detail: "API key 配置可用；共享一次配置仍待实现。",
    },
    {
      key: "resume",
      label: "会话恢复",
      status: "accepted",
      detail: "原生 Session ID 冷启动恢复已有安装证据。",
    },
    {
      key: "artifacts",
      label: "成果审阅",
      status: "partial",
      detail: "文件定位可用；完整 diff 与权限归因仍待补齐。",
    },
  ],
  codex: [
    {
      key: "launch",
      label: "安装与启动",
      status: "accepted",
      detail: "用户选定官方 0.143.0；新 ACP 组合未冻结。",
    },
    {
      key: "task",
      label: "正常任务",
      status: "accepted",
      detail: "App Server 文本与文件任务已有 QA 安装证据。",
    },
    {
      key: "intervention",
      label: "插话与跟进",
      status: "partial",
      detail: "原生转向已验收；ACP steering 扩展组合待核验。",
    },
    {
      key: "stop",
      label: "停止",
      status: "accepted",
      detail: "interrupt 与结果未知恢复已有 QA 证据。",
    },
    {
      key: "interaction",
      label: "权限与提问",
      status: "partial",
      detail: "审批与 Plan 提问已验收；默认模式提问仍关闭。",
    },
    {
      key: "provider",
      label: "Provider 与模型",
      status: "partial",
      detail: "ChatGPT 登录可用；API key 真实请求未验收。",
    },
    {
      key: "resume",
      label: "会话恢复",
      status: "partial",
      detail: "官方线程恢复可用；冷历史命令细节有限。",
    },
    {
      key: "artifacts",
      label: "成果审阅",
      status: "partial",
      detail: "文件定位三路可用；完整 diff 后续补齐。",
    },
  ],
};

export function retentionCapabilitiesForRuntime(
  runtime: RuntimeProduct,
  snapshot?: RuntimeAuthoritySnapshot | null,
): RuntimeRetentionCapability[] {
  if (
    snapshot?.runtime.productId === runtime &&
    snapshot.retentionCapabilities.length > 0
  ) {
    return snapshot.retentionCapabilities;
  }
  return fallbackRetentionCapabilities[runtime];
}

export function runtimeRetentionRows(
  runtime: RuntimeProduct,
  snapshot?: RuntimeAuthoritySnapshot | null,
): string[] {
  return retentionCapabilitiesForRuntime(runtime, snapshot).map(
    (capability) =>
      `${capability.label}：${capabilityStatusLabel[capability.status]} · ${capability.detail}`,
  );
}
