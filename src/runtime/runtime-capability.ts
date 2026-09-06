import { invoke } from "@tauri-apps/api/core";
import type { RuntimeIdentity } from "./adapter";

interface CapabilitySet<T> {
  base: T;
  contributesToLifeModel: T;
  usesLifeModel: T;
}

export interface RuntimeAuthoritySnapshot {
  runtime: RuntimeIdentity;
  runtimeBuildId: string;
  adapterSupport: CapabilitySet<boolean>;
  releaseCertification: CapabilitySet<{
    certified: boolean;
    evidenceCode: string;
  }>;
  installationCompatibility: CapabilitySet<{
    compatible: boolean;
    observedVersion: string | null;
    detail: string | null;
  }>;
  liveReadiness: CapabilitySet<{ ready: boolean; reasonCode: string | null }>;
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
    snapshot.releaseCertification.base.certified
      ? "本版本基础功能已验收"
      : "本版本基础功能待安装验收",
  ];
}
