import { describe, expect, it } from "vitest";
import {
  retentionCapabilitiesForRuntime,
  runtimeCapabilityRows,
  runtimeRetentionRows,
  type RuntimeAuthoritySnapshot,
} from "./runtime-capability";

function snapshot(): RuntimeAuthoritySnapshot {
  const install = { compatible: true, observedVersion: "1.2.3", detail: null };
  const live = { ready: false, reasonCode: "runtime_not_running" };
  return {
    runtime: { productId: "pi", installationId: "test", adapterId: "test" },
    runtimeBuildId: "test",
    adapterSupport: {
      base: true,
      contributesToLifeModel: true,
      usesLifeModel: false,
    },
    installationCompatibility: {
      base: install,
      contributesToLifeModel: install,
      usesLifeModel: install,
    },
    liveReadiness: {
      base: live,
      contributesToLifeModel: live,
      usesLifeModel: live,
    },
    retentionCapabilities: [],
  };
}

describe("Runtime capability presentation", () => {
  it("does not turn support or an installed artifact into release acceptance", () => {
    const rows = runtimeCapabilityRows(snapshot());
    expect(rows.join()).not.toContain("安装验收");
    expect(rows).toContain("LifeModel 来源：已支持");
    expect(rows).toContain("LifeModel 使用：未支持");
    expect(rows.join()).not.toContain("本版本基础功能已验收");
  });
  it("reports absent evidence and failed installation without a verified label", () => {
    expect(runtimeCapabilityRows(null)).toEqual(["能力状态尚未取得"]);
    const value = snapshot();
    value.installationCompatibility.base.compatible = false;
    const rows = runtimeCapabilityRows(value);
    expect(rows[0]).toBe("运行组件不可用，请检查安装");
    expect(rows.join()).not.toContain("运行组件已校验");
  });
});

describe("Runtime capability-retention contract", () => {
  it("keeps Pi native intervention separate from the ACP candidate gap", () => {
    const rows = runtimeRetentionRows("pi");
    expect(rows.join("\n")).toContain("插话与跟进：已验收");
    expect(rows.join("\n")).toContain("ACP input/editor 候选有缺口");
  });

  it("does not mark OpenCode ACP cancellation as retained", () => {
    const stop = retentionCapabilitiesForRuntime("opencode").find(
      (capability) => capability.key === "stop",
    );
    expect(stop?.status).toBe("version_blocked");
    expect(stop?.detail).toContain("取消路径返回不支持");
  });

  it("prefers Host-provided retention evidence over the fallback rows", () => {
    const value = snapshot();
    value.retentionCapabilities = [
      {
        key: "stop",
        label: "停止",
        status: "version_blocked",
        detail: "Host 复核结果。",
      },
    ];

    expect(runtimeRetentionRows("pi", value)).toEqual([
      "停止：版本阻断 · Host 复核结果。",
    ]);
  });

  it("keeps Codex accepted App Server work separate from an unfrozen ACP combination", () => {
    const rows = runtimeRetentionRows("codex");
    expect(rows.join("\n")).toContain("正常任务：已验收");
    expect(rows.join("\n")).toContain("新 ACP 组合未冻结");
    expect(rows.join("\n")).toContain("默认模式提问仍关闭");
  });
});
