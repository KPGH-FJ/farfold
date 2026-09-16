import type { HostPendingInteraction, HostSessionBinding } from "./host-shadow";
import type { OpenCodeSessionBindingRecord } from "./opencode";
import {
  OPENCODE_ACP_ADAPTER_ID,
  type OpenCodeAcpStatus,
} from "./opencode-acp";

export function openCodeAcpSessionReady(
  binding: OpenCodeSessionBindingRecord | null,
  status: Pick<
    OpenCodeAcpStatus,
    | "running"
    | "sessionId"
    | "runtimeConnectionId"
    | "runtimeBuildId"
    | "runtime"
    | "cwd"
  > | null,
  projectPath: string | null,
): boolean {
  return Boolean(
    binding &&
    status?.running &&
    binding.runtime.adapterId === OPENCODE_ACP_ADAPTER_ID &&
    status.sessionId === binding.nativeSessionId &&
    status.runtimeConnectionId === binding.connectionId &&
    status.runtimeBuildId === binding.runtimeBuildId &&
    status.runtime.installationId === binding.runtime.installationId &&
    status.runtime.adapterId === binding.runtime.adapterId &&
    status.cwd === binding.projectPath &&
    projectPath === binding.projectPath,
  );
}

export interface OpenCodeAcpManagedProviderStatus {
  providerConnectionId: string;
  providerConfigVersionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
}

export interface OpenCodeAcpTurnProviderBinding {
  providerConnectionId: string;
  providerConfigVersionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
}

export type OpenCodePostCreateActivation =
  | {
      kind: "acp";
      binding: OpenCodeSessionBindingRecord;
      hostSessionId: string;
      nativeSessionId: string;
    }
  | { kind: "server"; binding: OpenCodeSessionBindingRecord };

export function bindingFromHostSession(
  session: HostSessionBinding,
): OpenCodeSessionBindingRecord {
  return {
    farfoldSessionId: session.farfoldSessionId,
    runtime: {
      productId: session.runtimeProductId,
      installationId: session.installationId,
      adapterId: session.adapterId,
    },
    connectionId: session.connectionId,
    runtimeBuildId: session.runtimeBuildId,
    nativeSessionId: session.nativeSessionId,
    projectPath: session.workingCopyPath,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function openCodePostCreateActivation(
  session: HostSessionBinding,
): OpenCodePostCreateActivation {
  const binding = bindingFromHostSession(session);
  if (session.adapterId === OPENCODE_ACP_ADAPTER_ID) {
    return {
      kind: "acp",
      binding,
      hostSessionId: session.farfoldSessionId,
      nativeSessionId: session.nativeSessionId,
    };
  }
  return { kind: "server", binding };
}

export function openCodeAcpTurnProviderBinding(
  managedProvider: OpenCodeAcpManagedProviderStatus | null | undefined,
): OpenCodeAcpTurnProviderBinding | null {
  if (!managedProvider) return null;
  return {
    providerConnectionId: managedProvider.providerConnectionId,
    providerConfigVersionId: managedProvider.providerConfigVersionId,
    runtimeProviderId: managedProvider.runtimeProviderId,
    runtimeModelId: managedProvider.runtimeModelId,
  };
}

export function openCodePendingPermissionIds(
  interactions: readonly HostPendingInteraction[],
  binding: OpenCodeSessionBindingRecord,
  runtimeGeneration: number | null | undefined,
): Set<string> {
  if (!runtimeGeneration) return new Set();
  return new Set(
    interactions
      .filter(
        (interaction) =>
          (interaction.kind === "open_code_permission" ||
            interaction.kind === "open_code_question") &&
          (interaction.state === "pending" ||
            interaction.state === "responding") &&
          interaction.runtime.productId === binding.runtime.productId &&
          interaction.runtime.installationId ===
            binding.runtime.installationId &&
          interaction.runtime.adapterId === binding.runtime.adapterId &&
          interaction.runtimeGeneration === runtimeGeneration &&
          interaction.nativeSessionId === binding.nativeSessionId,
      )
      .map((interaction) => interaction.interactionId),
  );
}
