import { describe, expect, it } from "vitest";
import {
  runtimeCapabilityRows,
  type RuntimeAuthoritySnapshot,
} from "./runtime-capability";

function snapshot(): RuntimeAuthoritySnapshot {
  const install = { compatible: true, observedVersion: "1.2.3", detail: null };
  const release = { certified: false, evidenceCode: "pending" };
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
    releaseCertification: {
      base: release,
      contributesToLifeModel: release,
      usesLifeModel: release,
    },
    liveReadiness: {
      base: live,
      contributesToLifeModel: live,
      usesLifeModel: live,
    },
  };
}

describe("Runtime capability presentation", () => {
  it("does not turn support or an installed artifact into release acceptance", () => {
    const rows = runtimeCapabilityRows(snapshot());
    expect(rows).toContain("本版本基础功能待安装验收");
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
