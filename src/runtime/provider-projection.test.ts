import { describe, expect, it } from "vitest";
import {
  providerProjectionChangePolicy,
  nativeConfigurationFingerprint,
  providerRuntimeBindingState,
  providerTargetProjectionLabel,
  summarizeProviderProjection,
  type HostProviderProjectionSnapshot,
  type ProviderTargetProjection,
} from "./provider-projection";

it("hashes native configuration identities without unsafe characters or delimiter collisions", async () => {
  const fingerprint = await nativeConfigurationFingerprint([
    "model",
    "opencode/big-pickle",
  ]);
  expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(
    await nativeConfigurationFingerprint(["model", "opencode/big-pickle"]),
  ).toBe(fingerprint);
  expect(await nativeConfigurationFingerprint(["a:b", "c"])).not.toBe(
    await nativeConfigurationFingerprint(["a", "b:c"]),
  );
});

const base: ProviderTargetProjection = {
  providerConnectionId: "provider-zai-primary",
  providerConfigVersionId: "version-1",
  runtimeProductId: "pi",
  installationId: "bundled-pi",
  runtimeConnectionId: "pi-local-native-config-v1",
  runtimeProviderId: "zai",
  runtimeModelId: "glm-4.5-air",
  providerId: "zai",
  source: "farfold_managed",
  saveState: "saved",
  applyState: "applied",
  requestState: "not_requested",
  requestVerifiedVersionId: null,
  activeTaskPolicy: "current_task_keeps_bound_config",
};

const snapshot: HostProviderProjectionSnapshot = {
  connection: {
    providerConnectionId: "provider-zai-primary",
    providerKey: "zai",
    label: "Z.AI primary",
    source: "farfold_managed",
    currentConfigVersionId: "version-1",
    createdAt: 1,
    updatedAt: 1,
  },
  projections: [
    {
      providerConnectionId: "provider-zai-primary",
      runtimeProductId: "opencode",
      installationId: "bundled-opencode",
      runtimeConnectionId: "opencode-local-native-config-v1",
      configVersionId: "version-1",
      runtimeProviderId: "zai",
      runtimeModelId: "glm-4.5-air",
      saveState: "saved",
      applyState: "applied",
      requestState: "not_requested",
      requestVerifiedVersionId: null,
      activeTaskPolicy: "current_task_keeps_bound_config",
      detail: null,
      updatedAt: 2,
    },
  ],
};

describe("Provider projection contract", () => {
  it("does not turn one verified Runtime into global success", () => {
    const summary = summarizeProviderProjection([
      {
        ...base,
        requestState: "verified_success",
        requestVerifiedVersionId: "version-1",
      },
      {
        ...base,
        runtimeProductId: "opencode",
        requestState: "not_requested",
      },
    ]);

    expect(summary.allTargetsVerified).toBe(false);
    expect(summary.tone).toBe("configured");
    expect(summary.label).toContain("Pi 请求已验证");
    expect(summary.label).toContain("OpenCode 已应用，请求未验证");
  });

  it("invalidates stale request verification when the config version changes", () => {
    const summary = summarizeProviderProjection([
      {
        ...base,
        providerConfigVersionId: "version-2",
        requestState: "verified_success",
        requestVerifiedVersionId: "version-1",
      },
    ]);

    expect(summary.allTargetsVerified).toBe(false);
    expect(summary.tone).toBe("configured");
    expect(summary.label).toContain("旧请求验证已失效");
  });

  it("reports partial failures without marking unaffected Runtime projections failed", () => {
    const summary = summarizeProviderProjection([
      {
        ...base,
        requestState: "verified_success",
        requestVerifiedVersionId: "version-1",
      },
      {
        ...base,
        runtimeProductId: "codex",
        installationId: "codex@0.143.0",
        runtimeConnectionId: "codex-system-local",
        applyState: "failed",
        requestState: "not_requested",
      },
    ]);

    expect(summary.tone).toBe("failed");
    expect(summary.blockedRuntimeIds).toEqual(["codex"]);
    expect(summary.label).toContain("Codex 应用失败");
    expect(summary.label).not.toContain("Pi 保存失败");
  });

  it("keeps unmanaged native configuration outside Farfold overwrite policy", () => {
    expect(
      providerTargetProjectionLabel({
        ...base,
        runtimeProductId: "codex",
        installationId: "codex@0.143.0",
        runtimeConnectionId: "codex-system-local",
        source: "native_unmanaged",
        requestState: "verified_success",
        requestVerifiedVersionId: "version-1",
      }),
    ).toBe("Codex 使用原生独立配置；Farfold 不覆盖");
  });

  it("keeps active tasks bound to the configuration captured at start", () => {
    expect(providerProjectionChangePolicy([base])).toContain(
      "当前活动任务继续使用启动时绑定的配置",
    );
  });

  it("binds only an applied Farfold managed projection for the exact Runtime model", () => {
    expect(
      providerRuntimeBindingState(snapshot, {
        runtimeProductId: "opencode",
        installationId: "bundled-opencode",
        runtimeConnectionId: "opencode-local-native-config-v1",
        runtimeProviderId: "zai",
        runtimeModelId: "glm-4.5-air",
      }),
    ).toEqual({
      kind: "bound",
      providerConnectionId: "provider-zai-primary",
      providerConfigVersionId: "version-1",
    });
    expect(
      providerRuntimeBindingState(snapshot, {
        runtimeProductId: "opencode",
        installationId: "bundled-opencode",
        runtimeConnectionId: "opencode-local-native-config-v1",
        runtimeProviderId: "zai",
        runtimeModelId: "wrong-model",
      }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("blocks Farfold managed Provider submissions while projection is pending or failed", () => {
    for (const projection of [
      { saveState: "saved" as const, applyState: "pending" as const },
      { saveState: "saved" as const, applyState: "failed" as const },
      { saveState: "failed" as const, applyState: "failed" as const },
    ]) {
      expect(
        providerRuntimeBindingState(
          {
            ...snapshot,
            projections: [{ ...snapshot.projections[0], ...projection }],
          },
          {
            runtimeProductId: "opencode",
            installationId: "bundled-opencode",
            runtimeConnectionId: "opencode-local-native-config-v1",
            runtimeProviderId: "zai",
            runtimeModelId: "glm-4.5-air",
          },
        ),
      ).toMatchObject({ kind: "blocked" });
    }
  });

  it("allows native unmanaged or absent Provider records to proceed without a Farfold binding", () => {
    expect(providerRuntimeBindingState(null, null)).toEqual({
      kind: "not_configured",
    });
    expect(
      providerRuntimeBindingState(
        {
          ...snapshot,
          connection: { ...snapshot.connection, source: "native_unmanaged" },
        },
        {
          runtimeProductId: "opencode",
          installationId: "bundled-opencode",
          runtimeConnectionId: "opencode-local-native-config-v1",
          runtimeProviderId: "zai",
          runtimeModelId: "glm-4.5-air",
        },
      ),
    ).toEqual({ kind: "native_unmanaged" });
  });
});
