import { invoke } from "@tauri-apps/api/core";
import type { RuntimeIdentity } from "./adapter";
import {
  hostTurnAbort,
  hostTurnSubmit,
  type HostTurnOutcome,
} from "./host-turn";
import { readActiveHostTurns, type ActiveHostTurn } from "./host-turns";
import type {
  HostProviderProjectionSnapshot,
  ProviderTargetProjection,
} from "./provider-projection";
import {
  hostRoutedEventMatchesBinding,
  type HostRoutedEvent,
  type HostPendingInteraction,
  type HostSessionBinding,
} from "./host-shadow";

export const PI_ACP_ADAPTER_ID = "pi-acp-stdio-v1";
export const PI_ACP_INSTALLATION_ID = "bundled-pi-acp";
export const PI_ACP_START_CONNECTION_ID = "pi-acp-managed-local-v1";

export interface PiAcpTarget {
  farfoldSessionId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
}

export interface PiAcpTurnTarget extends PiAcpTarget {
  turnId: string;
}

export async function piAcpActiveTurn(
  binding: HostSessionBinding,
  generation: number,
): Promise<ActiveHostTurn | null> {
  if (
    binding.runtimeProductId !== "pi" ||
    binding.adapterId !== PI_ACP_ADAPTER_ID
  )
    return null;
  return (
    (await readActiveHostTurns()).find(
      (turn) =>
        turn.farfoldSessionId === binding.farfoldSessionId &&
        turn.runtimeProductId === "pi" &&
        turn.installationId === binding.installationId &&
        turn.runtimeConnectionId === binding.connectionId &&
        turn.nativeSessionId === binding.nativeSessionId &&
        turn.runtimeGeneration === generation,
    ) ?? null
  );
}

export interface PiAcpManagedProviderBinding {
  providerConnectionId: string;
  providerConfigVersionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
}

export type PiAcpModelSource =
  | { kind: "managed_version"; binding: PiAcpManagedProviderBinding }
  | {
      kind: "native_observation";
      runtimeProviderId: string;
      runtimeModelId: string;
      nativeModelId: string;
    };

export type PiNativeFirstUseState =
  | { version: 1; phase: "authentication_required" }
  | { version: 1; phase: "model_selection_required" }
  | { version: 1; phase: "ready"; provider: string; modelId: string };

export interface PiAcpStatus {
  running: boolean;
  generation: number;
  runtime: RuntimeIdentity | null;
  runtimeBuildId: string | null;
  runtimeConnectionId: string | null;
  cwd: string | null;
  nativeSession: {
    version: 1;
    sessionId: string;
    sessionFile: string;
    cwd: string;
  } | null;
  configOptions: unknown;
  managedProvider: PiAcpManagedProviderBinding | null;
  modelSource: PiAcpModelSource | null;
  nativeAdmissionReady: boolean;
  nativeFirstUse: PiNativeFirstUseState | null;
  lastConfirmedModelSource: PiAcpModelSource | null;
  configurationState: "confirmed" | "changing" | "unknown";
  lastError: string | null;
  droppedEvents: number;
}

export function piAcpTargetForBinding(
  status: PiAcpStatus,
  binding: HostSessionBinding,
): PiAcpTarget | null {
  return status.running ? piAcpCleanupTargetForBinding(status, binding) : null;
}

// Explicit cleanup still needs the retained identity after process exit.
// This target must not authorize prompts, configuration or native reads.
export function piAcpCleanupTargetForBinding(
  status: PiAcpStatus,
  binding: HostSessionBinding,
): PiAcpTarget | null {
  if (
    !Number.isSafeInteger(status.generation) ||
    status.generation < 1 ||
    binding.archivedAt !== null ||
    binding.runtimeProductId !== "pi" ||
    binding.adapterId !== PI_ACP_ADAPTER_ID ||
    status.runtime?.productId !== "pi" ||
    status.runtime.adapterId !== binding.adapterId ||
    status.runtime.installationId !== binding.installationId ||
    status.runtimeBuildId !== binding.runtimeBuildId ||
    status.runtimeConnectionId !== binding.connectionId ||
    status.cwd !== binding.workingCopyPath ||
    status.nativeSession?.version !== 1 ||
    status.nativeSession.sessionId !== binding.nativeSessionId ||
    status.nativeSession.cwd !== binding.workingCopyPath
  )
    return null;
  return {
    farfoldSessionId: binding.farfoldSessionId,
    nativeSessionId: binding.nativeSessionId,
    runtimeGeneration: status.generation,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function piAcpBoundParams(
  event: HostRoutedEvent,
  binding: HostSessionBinding,
  generation: number,
): Record<string, unknown> | null {
  if (
    binding.runtimeProductId !== "pi" ||
    binding.adapterId !== PI_ACP_ADAPTER_ID ||
    event.preservation !== "native" ||
    !hostRoutedEventMatchesBinding(event, {
      runtime: {
        productId: binding.runtimeProductId,
        installationId: binding.installationId,
        adapterId: binding.adapterId,
      },
      runtimeBuildId: binding.runtimeBuildId,
      connectionId: binding.connectionId,
      runtimeGeneration: generation,
    })
  )
    return null;
  const envelope = record(event.nativeEnvelope);
  const payload = record(envelope?.payload);
  const params = record(payload?.params);
  if (
    envelope?.kind !== "acp" ||
    envelope.generation !== generation ||
    params?.sessionId !== binding.nativeSessionId
  )
    return null;
  return { ...params, method: payload?.method };
}

export function piAcpNativeEvent(
  event: HostRoutedEvent,
  binding: HostSessionBinding,
  generation: number,
): Record<string, unknown> | null {
  const params = piAcpBoundParams(event, binding, generation);
  return params?.method === "_pi/event" && params.version === 1
    ? record(params.event)
    : null;
}

export interface PiAcpControlOutput {
  id: string;
  text: string;
}

export function piAcpControlOutput(
  event: HostRoutedEvent,
  binding: HostSessionBinding,
  generation: number,
): PiAcpControlOutput | null {
  const params = piAcpBoundParams(event, binding, generation);
  const update = record(params?.update);
  const content = record(update?.content);
  const meta = record(record(update?._meta)?.farfoldPi);
  if (
    params?.method !== "session/update" ||
    update?.sessionUpdate !== "agent_message_chunk" ||
    content?.type !== "text" ||
    typeof content.text !== "string" ||
    meta?.version !== 1 ||
    meta.origin !== "adapter_control" ||
    typeof meta.id !== "string" ||
    !meta.id ||
    meta.id.length > 200
  )
    return null;
  return { id: meta.id, text: content.text };
}

export function piAcpControlScope(
  binding: HostSessionBinding,
  generation: number,
): string {
  return JSON.stringify([
    binding.farfoldSessionId,
    binding.nativeSessionId,
    binding.runtimeProductId,
    binding.installationId,
    binding.runtimeBuildId,
    binding.adapterId,
    binding.connectionId,
    generation,
  ]);
}

export function appendPiAcpControlOutput(
  outputs: PiAcpControlOutput[],
  output: PiAcpControlOutput,
): PiAcpControlOutput[] {
  return outputs.some((item) => item.id === output.id)
    ? outputs
    : [...outputs, output];
}

export type PiAcpWorkspaceSection =
  | "auth_catalog"
  | "configuration"
  | "state"
  | "messages"
  | "entries"
  | "models"
  | "thinking_levels"
  | "commands"
  | "stats"
  | "session_command";

export type PiAcpDialogAnswer =
  | { kind: "cancel" }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "text"; value: string };

export function piAcpPendingDialogs(
  status: PiAcpStatus,
  binding: HostSessionBinding,
  pending: HostPendingInteraction[],
): HostPendingInteraction[] {
  if (!piAcpTargetForBinding(status, binding)) return [];
  return pending.filter(
    (interaction) =>
      interaction.kind === "pi_extension_dialog" &&
      interaction.runtime.productId === binding.runtimeProductId &&
      interaction.runtime.installationId === binding.installationId &&
      interaction.runtime.adapterId === binding.adapterId &&
      interaction.runtimeGeneration === status.generation &&
      interaction.nativeSessionId === binding.nativeSessionId &&
      interaction.piAcp?.nativeSessionId === binding.nativeSessionId &&
      interaction.piAcp.nativeEvent.id === interaction.piAcp.nativeRequestId,
  );
}

export function piAcpProviderProjection(
  status: PiAcpStatus,
  binding: HostSessionBinding,
  snapshot: HostProviderProjectionSnapshot | null,
): ProviderTargetProjection | null {
  const provider =
    status.modelSource?.kind === "managed_version"
      ? status.modelSource.binding
      : null;
  if (
    status.configurationState !== "confirmed" ||
    !provider ||
    !snapshot ||
    !piAcpTargetForBinding(status, binding) ||
    snapshot.connection.providerConnectionId !== provider.providerConnectionId
  )
    return null;
  const projection = snapshot.projections.find(
    (candidate) =>
      candidate.providerConnectionId === provider.providerConnectionId &&
      candidate.configVersionId === provider.providerConfigVersionId &&
      candidate.runtimeProductId === "pi" &&
      candidate.installationId === binding.installationId &&
      candidate.runtimeConnectionId === binding.connectionId &&
      candidate.runtimeProviderId === provider.runtimeProviderId &&
      candidate.runtimeModelId === provider.runtimeModelId,
  );
  return projection
    ? {
        ...projection,
        providerConfigVersionId: projection.configVersionId,
        providerId: snapshot.connection.providerKey,
        source: snapshot.connection.source,
        detail: projection.detail ?? undefined,
      }
    : null;
}

export function piAcpStatus(): Promise<PiAcpStatus> {
  return invoke("pi_acp_status");
}

export function readPiAcpWorkspace(
  input: PiAcpTarget & { section: PiAcpWorkspaceSection },
): Promise<unknown> {
  return invoke("pi_acp_workspace", { input });
}

export async function readPiAcpWorkspaceSnapshot(
  target: PiAcpTarget,
  stillCurrent: () => boolean,
): Promise<[PiAcpWorkspaceSection, unknown][] | null> {
  const snapshots: [PiAcpWorkspaceSection, unknown][] = [];
  // One native read at a time. Discard the whole snapshot on identity/event drift.
  for (const section of [
    "state",
    "models",
    "thinking_levels",
    "messages",
    "commands",
    "stats",
  ] as const) {
    if (!stillCurrent()) return null;
    const value = await readPiAcpWorkspace({ ...target, section });
    if (!stillCurrent()) return null;
    if (
      section === "state" &&
      record(value)?.sessionId !== target.nativeSessionId
    )
      throw new Error("Pi ACP 历史快照的原生会话与目标不一致。");
    snapshots.push([section, value]);
  }
  return snapshots;
}

export function submitPiAcpTurn(
  input: PiAcpTarget & { text: string },
): Promise<HostTurnOutcome> {
  return hostTurnSubmit({
    farfoldSessionId: input.farfoldSessionId,
    nativeSessionId: input.nativeSessionId,
    text: input.text,
  });
}

export function abortPiAcpTurn(input: PiAcpTurnTarget): Promise<boolean> {
  return hostTurnAbort({
    farfoldSessionId: input.farfoldSessionId,
    nativeSessionId: input.nativeSessionId,
  });
}

export function intervenePiAcpTurn(
  input: PiAcpTurnTarget & { kind: "steer" | "follow_up"; message: string },
): Promise<
  | { outcome: "queued"; delivery: "steer" | "follow_up" }
  | { outcome: "unknown"; detail: string }
> {
  return invoke("host_pi_acp_intervene", { input });
}

export function respondPiAcpDialog(
  input: PiAcpTarget & {
    requestId: string;
    nativeRequestId: string;
    answer: PiAcpDialogAnswer;
  },
): Promise<void> {
  return invoke("pi_acp_respond_dialog", { input });
}

export function setPiAcpConfigOption(
  input: PiAcpTarget & { configId: "model" | "thought_level"; value: string },
): Promise<PiAcpStatus> {
  return invoke("pi_acp_set_config_option", { input });
}

export function applyPiAcpProvider(
  input: PiAcpTarget & {
    provider: { providerConnectionId: string; providerConfigVersionId: string };
  },
): Promise<PiAcpStatus> {
  return invoke("pi_acp_apply_provider", { input });
}
