import { invoke } from "@tauri-apps/api/core";

export async function nativeConfigurationFingerprint(
  parts: readonly string[],
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type RuntimeProductId = "pi" | "opencode" | "codex";

export type ProviderConnectionSource = "farfold_managed" | "native_unmanaged";

export type ProviderSaveState = "not_saved" | "saved" | "failed";

export type ProviderApplyState =
  "not_applicable" | "pending" | "applied" | "needs_restart" | "failed";

export type ProviderRequestState =
  "not_requested" | "verified_success" | "verified_failure";

export interface ProviderTargetProjection {
  providerConnectionId: string;
  providerConfigVersionId: string;
  runtimeProductId: RuntimeProductId;
  installationId: string;
  runtimeConnectionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
  providerId: string;
  source: ProviderConnectionSource;
  saveState: ProviderSaveState;
  applyState: ProviderApplyState;
  requestState: ProviderRequestState;
  requestVerifiedVersionId: string | null;
  activeTaskPolicy: "current_task_keeps_bound_config" | "applies_immediately";
  detail?: string;
}

export interface HostProviderConnectionUpsertInput {
  providerConnectionId: string;
  providerKey: string;
  label: string;
  source: ProviderConnectionSource;
  endpointFingerprint: string;
  credentialRevisionFingerprint: string;
  modelMappingFingerprint: string;
}

export interface HostProviderTargetProjectionInput {
  providerConnectionId: string;
  configVersionId: string;
  runtimeProductId: RuntimeProductId;
  installationId: string;
  runtimeConnectionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
  saveState: ProviderSaveState;
  applyState: ProviderApplyState;
  requestState: ProviderRequestState;
  requestVerifiedVersionId: string | null;
  activeTaskPolicy: "current_task_keeps_bound_config" | "applies_immediately";
  detail?: string | null;
}

export interface HostProviderProjectionSnapshot {
  connection: {
    providerConnectionId: string;
    providerKey: string;
    label: string;
    source: ProviderConnectionSource;
    currentConfigVersionId: string;
    createdAt: number;
    updatedAt: number;
  };
  projections: {
    providerConnectionId: string;
    runtimeProductId: RuntimeProductId;
    installationId: string;
    runtimeConnectionId: string;
    configVersionId: string;
    runtimeProviderId: string;
    runtimeModelId: string;
    saveState: ProviderSaveState;
    applyState: ProviderApplyState;
    requestState: ProviderRequestState;
    requestVerifiedVersionId: string | null;
    activeTaskPolicy: "current_task_keeps_bound_config" | "applies_immediately";
    detail: string | null;
    updatedAt: number;
  }[];
}

export interface ProviderProjectionSummary {
  label: string;
  tone: "" | "configured" | "verified" | "failed";
  allTargetsVerified: boolean;
  blockedRuntimeIds: RuntimeProductId[];
}

export type ProviderRuntimeBindingState =
  | { kind: "not_configured" }
  | { kind: "native_unmanaged" }
  | {
      kind: "bound";
      providerConnectionId: string;
      providerConfigVersionId: string;
    }
  | { kind: "blocked"; reason: string };

export interface ProviderRuntimeBindingTarget {
  runtimeProductId: RuntimeProductId;
  installationId: string;
  runtimeConnectionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
}

function runtimeLabel(runtime: RuntimeProductId): string {
  switch (runtime) {
    case "pi":
      return "Pi";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
  }
}

export function providerTargetProjectionLabel(
  projection: ProviderTargetProjection,
): string {
  const runtime = runtimeLabel(projection.runtimeProductId);
  if (projection.source === "native_unmanaged") {
    return `${runtime} 使用原生独立配置；Farfold 不覆盖`;
  }
  if (projection.saveState === "failed") return `${runtime} 保存失败`;
  if (projection.applyState === "failed") return `${runtime} 应用失败`;
  if (projection.requestState === "verified_failure") {
    return `${runtime} 请求验证失败`;
  }
  if (
    projection.requestState === "verified_success" &&
    projection.requestVerifiedVersionId === projection.providerConfigVersionId
  ) {
    return `${runtime} 请求已验证`;
  }
  if (projection.requestState === "verified_success") {
    return `${runtime} 旧请求验证已失效`;
  }
  if (projection.applyState === "needs_restart") {
    return `${runtime} 已保存，需重启 Runtime 生效`;
  }
  if (projection.applyState === "applied") {
    return `${runtime} 已应用，请求未验证`;
  }
  if (projection.applyState === "pending") {
    return `${runtime} 等待应用`;
  }
  if (projection.saveState === "saved") return `${runtime} 已保存`;
  return `${runtime} 尚未保存`;
}

export function summarizeProviderProjection(
  projections: readonly ProviderTargetProjection[],
): ProviderProjectionSummary {
  if (projections.length === 0) {
    return {
      label: "尚未选择目标 Runtime",
      tone: "",
      allTargetsVerified: false,
      blockedRuntimeIds: [],
    };
  }
  const blocked = projections.filter(
    (projection) =>
      projection.saveState === "failed" ||
      projection.applyState === "failed" ||
      projection.requestState === "verified_failure",
  );
  if (blocked.length > 0) {
    return {
      label: blocked.map(providerTargetProjectionLabel).join("；"),
      tone: "failed",
      allTargetsVerified: false,
      blockedRuntimeIds: blocked.map(
        (projection) => projection.runtimeProductId,
      ),
    };
  }
  const allVerified = projections.every(
    (projection) =>
      projection.source === "farfold_managed" &&
      projection.requestState === "verified_success" &&
      projection.requestVerifiedVersionId ===
        projection.providerConfigVersionId,
  );
  if (allVerified) {
    return {
      label: projections.map(providerTargetProjectionLabel).join("；"),
      tone: "verified",
      allTargetsVerified: true,
      blockedRuntimeIds: [],
    };
  }
  return {
    label: projections.map(providerTargetProjectionLabel).join("；"),
    tone: projections.some(
      (projection) =>
        projection.saveState === "saved" ||
        projection.applyState === "applied" ||
        projection.applyState === "needs_restart",
    )
      ? "configured"
      : "",
    allTargetsVerified: false,
    blockedRuntimeIds: [],
  };
}

export function providerRuntimeBindingState(
  snapshot: HostProviderProjectionSnapshot | null,
  target: ProviderRuntimeBindingTarget | null,
): ProviderRuntimeBindingState {
  if (!snapshot || !target) return { kind: "not_configured" };
  if (snapshot.connection.source === "native_unmanaged") {
    return { kind: "native_unmanaged" };
  }
  const projection = snapshot.projections.find(
    (candidate) =>
      candidate.runtimeProductId === target.runtimeProductId &&
      candidate.installationId === target.installationId &&
      candidate.runtimeConnectionId === target.runtimeConnectionId &&
      candidate.runtimeProviderId === target.runtimeProviderId &&
      candidate.runtimeModelId === target.runtimeModelId,
  );
  if (!projection) {
    return {
      kind: "blocked",
      reason: "Farfold 管理的模型服务尚未应用到当前 Runtime / 模型。",
    };
  }
  if (
    projection.configVersionId !== snapshot.connection.currentConfigVersionId
  ) {
    return {
      kind: "blocked",
      reason: "模型服务配置已更新，当前 Runtime 尚未应用最新版本。",
    };
  }
  if (projection.saveState === "failed" || projection.applyState === "failed") {
    return {
      kind: "blocked",
      reason: "模型服务配置保存或应用失败，请先重新配置。",
    };
  }
  if (projection.saveState !== "saved" || projection.applyState !== "applied") {
    return {
      kind: "blocked",
      reason: "模型服务配置尚未应用完成，请先完成应用。",
    };
  }
  return {
    kind: "bound",
    providerConnectionId: snapshot.connection.providerConnectionId,
    providerConfigVersionId: projection.configVersionId,
  };
}

export function upsertHostProviderConnection(
  input: HostProviderConnectionUpsertInput,
): Promise<HostProviderProjectionSnapshot> {
  return invoke("host_provider_connection_upsert", { input });
}

export function recordHostProviderProjection(
  input: HostProviderTargetProjectionInput,
): Promise<HostProviderProjectionSnapshot> {
  return invoke("host_provider_projection_record", { input });
}

export function readHostProviderProjection(
  providerConnectionId: string,
): Promise<HostProviderProjectionSnapshot> {
  return invoke("host_provider_projection_snapshot", {
    input: { providerConnectionId },
  });
}

export function providerProjectionChangePolicy(
  projections: readonly ProviderTargetProjection[],
): string {
  return projections.some(
    (projection) =>
      projection.activeTaskPolicy === "current_task_keeps_bound_config",
  )
    ? "当前活动任务继续使用启动时绑定的配置；新配置只在对应 Runtime 的安全边界生效。"
    : "没有活动任务绑定旧配置。";
}
