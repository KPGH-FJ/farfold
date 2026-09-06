import { invoke } from "@tauri-apps/api/core";
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
  kind: "sse" | "protocol_error" | "transport_error";
  payload: unknown;
  runtime: RuntimeIdentity;
};

export interface OpenCodePromptInput {
  farfoldSessionId: string;
  nativeSessionId: string;
  providerId: string;
  modelId: string;
  text: string;
  lifeModelManifestId?: string;
}

export interface HostTurnSubmission {
  turnId: string;
  acceptedAt: number;
}

export interface OpenCodeTurnAbortInput {
  farfoldSessionId: string;
  nativeSessionId: string;
}

export interface OpenCodeNativeSession {
  id: string;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface OpenCodeSessionBindingRecord extends RuntimeSessionBinding {
  farfoldSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface OpenCodePermissionResponseInput {
  sessionId: string;
  permissionId: string;
  response: "once" | "always" | "reject";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseOpenCodeNativeSession(
  value: unknown,
): OpenCodeNativeSession | null {
  const session = record(value);
  const time = record(session?.time);
  if (
    typeof session?.id !== "string" ||
    !session.id.startsWith("ses_") ||
    typeof session.directory !== "string" ||
    typeof session.title !== "string" ||
    typeof time?.created !== "number" ||
    typeof time.updated !== "number"
  ) {
    return null;
  }
  return {
    id: session.id,
    projectPath: session.directory,
    title: session.title.trim() || "OpenCode Session",
    createdAt: time.created,
    updatedAt: time.updated,
  };
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

export function listOpenCodeSessions(): Promise<OpenCodeNativeSession[]> {
  return invoke<unknown[]>("opencode_session_list").then((sessions) =>
    sessions.flatMap((value) => {
      const session = parseOpenCodeNativeSession(value);
      return session ? [session] : [];
    }),
  );
}

export function openCodeSessionMessages(
  sessionId: string,
  limit = 200,
): Promise<unknown[]> {
  return invoke("opencode_session_messages", { sessionId, limit });
}

export function submitOpenCodeTurn(
  input: OpenCodePromptInput,
): Promise<HostTurnSubmission> {
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
