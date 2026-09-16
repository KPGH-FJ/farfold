import { invoke } from "@tauri-apps/api/core";
import { readActiveHostTurns } from "./host-turns";
import type {
  RuntimeConnectionReadiness,
  RuntimeDescriptor,
  RuntimeIdentity,
  RuntimeSessionBinding,
} from "./adapter";

export const OPENCODE_RUNTIME_IDENTITY: RuntimeIdentity = Object.freeze({
  productId: "opencode",
  installationId: "bundled-opencode-1.15.13-arm64",
  adapterId: "opencode-server-http-sse-v1",
});

export const OPENCODE_RUNTIME_CONNECTION_ID = "opencode-local-native-config-v1";

export function openCodeProviderConnectionId(providerId: string): string {
  return `opencode-provider-${providerId.replace(/[^A-Za-z0-9_.:@+-]/g, "_")}`;
}

export function openCodeCredentialRevisionFingerprint(
  action: "save_api_key" | "remove",
  nonce: string,
): string {
  const safeNonce = nonce.replace(/[^A-Za-z0-9_.:@+-]/g, "_");
  return `credential:${action}:${safeNonce}`;
}

export type OpenCodeRuntimePhase =
  "stopped" | "starting" | "running" | "stopping";

export interface OpenCodeRuntimeStatus {
  state: OpenCodeRuntimePhase;
  running: boolean;
  projectPath: string | null;
  endpoint: string | null;
  generation: number;
  version: string;
}

export function canReuseOpenCodeSession(
  status: Pick<OpenCodeRuntimeStatus, "state" | "running">,
  activeSessionId: string | null,
  requestedSessionId: string,
  reconnect: boolean,
): boolean {
  return (
    !reconnect &&
    status.state === "running" &&
    status.running &&
    activeSessionId === requestedSessionId
  );
}

export interface OpenCodeProviderModel {
  providerId: string;
  modelId: string;
  name: string;
  status: string;
}

export interface OpenCodeModelSelection {
  providerId: string;
  modelId: string;
}

type OpenCodeModelTarget = Pick<
  OpenCodeSessionBindingRecord,
  "farfoldSessionId" | "nativeSessionId"
>;

export function openCodeModelSelection(
  input: OpenCodeModelTarget,
): Promise<OpenCodeModelSelection | null> {
  return invoke("host_opencode_model_selection", { input });
}

export function selectOpenCodeModel(
  input: OpenCodeModelTarget,
  model: OpenCodeModelSelection,
): Promise<OpenCodeModelSelection> {
  return invoke("host_opencode_model_select", { input, model });
}

export interface OpenCodeProviderSnapshot {
  connectedProviderIds: string[];
  models: OpenCodeProviderModel[];
  provider: "ready" | "not_ready";
  model: "ready" | "not_ready";
  account: "unknown";
}

export interface OpenCodeAuthProvider {
  id: string;
  name: string;
  connected: boolean;
}

export function openCodeAuthProviders(): Promise<OpenCodeAuthProvider[]> {
  return invoke("opencode_auth_providers");
}

export type OpenCodeAuthChange =
  | { action: "save_api_key"; providerId: string; apiKey: string }
  | { action: "remove"; providerId: string };

export function changeOpenCodeAuth(input: OpenCodeAuthChange): Promise<void> {
  return invoke("opencode_auth_change", { input });
}

export type OpenCodeEnvelope = {
  generation: number;
  kind: "sse" | "protocol_error" | "transport_error" | "acp";
  payload: unknown;
  runtime: RuntimeIdentity;
};

export interface OpenCodePromptInput {
  farfoldSessionId: string;
  nativeSessionId: string;
  providerId: string;
  modelId: string;
  providerConnectionId?: string;
  providerConfigVersionId?: string;
  text: string;
  lifeModelManifestId?: string;
}

export interface HostTurnSubmission {
  turnId: string;
  acceptedAt: number;
}

export type OpenCodeTurnSubmission =
  | { outcome: "accepted"; submission: HostTurnSubmission }
  | { outcome: "unknown"; detail: string };

export interface OpenCodeRecoveryTarget {
  turnId: string;
  farfoldSessionId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
}

export async function openCodeRecoveryTarget(
  sessionId: string,
  generation?: number,
  installationId: string = OPENCODE_RUNTIME_IDENTITY.installationId,
): Promise<OpenCodeRecoveryTarget | null> {
  const turn = (await readActiveHostTurns()).find(
    (turn) =>
      turn.runtimeProductId === "opencode" &&
      turn.installationId === installationId &&
      turn.farfoldSessionId === sessionId &&
      (generation === undefined || turn.runtimeGeneration === generation),
  );
  return turn
    ? {
        turnId: turn.turnId,
        farfoldSessionId: turn.farfoldSessionId,
        nativeSessionId: turn.nativeSessionId,
        runtimeGeneration: turn.runtimeGeneration,
      }
    : null;
}

export interface OpenCodeTurnAbortInput {
  farfoldSessionId: string;
  nativeSessionId: string;
}

export interface OpenCodeSessionBindingRecord extends RuntimeSessionBinding {
  farfoldSessionId: string;
  runtimeBuildId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface OpenCodePermissionResponseInput {
  sessionId: string;
  permissionId: string;
  response: "once" | "always" | "reject";
}

export function discoverOpenCodeRuntime(): Promise<RuntimeDescriptor> {
  return invoke("opencode_runtime_discover");
}

export function openCodeRuntimeStatus(): Promise<OpenCodeRuntimeStatus> {
  return invoke("opencode_runtime_status");
}

export function openCodeRuntimeReadiness(): Promise<
  RuntimeConnectionReadiness<OpenCodeRuntimePhase>
> {
  return invoke("opencode_runtime_readiness");
}

export function openCodeProviderSnapshot(): Promise<OpenCodeProviderSnapshot> {
  return invoke("opencode_provider_snapshot");
}

export function openCodeSessionMessages(
  sessionId: string,
  limit = 200,
): Promise<unknown[]> {
  return invoke("opencode_session_messages", { sessionId, limit });
}

export function submitOpenCodeTurn(
  input: OpenCodePromptInput,
): Promise<OpenCodeTurnSubmission> {
  return invoke("host_opencode_turn_submit", { input });
}

export function abortOpenCodeTurn(
  input: OpenCodeTurnAbortInput,
): Promise<boolean> {
  return invoke("host_opencode_turn_abort", { input });
}

export function respondToOpenCodePermission(
  input: OpenCodePermissionResponseInput,
): Promise<unknown> {
  return invoke("opencode_permission_respond", { input });
}

export function openCodeRuntimeDiagnostics(): Promise<string[]> {
  return invoke("opencode_runtime_diagnostics");
}
