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

export const OPENCODE_LOCAL_CONNECTION_ID = "opencode-local-native-config-v1";

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

export interface OpenCodeStartOptions {
  projectPath: string;
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

export type OpenCodeEnvelope = {
  generation: number;
  kind: "sse" | "protocol_error" | "transport_error";
  payload: unknown;
  runtime: RuntimeIdentity;
};

export interface OpenCodePromptInput {
  sessionId: string;
  providerId: string;
  modelId: string;
  text: string;
  system?: string;
}

export interface OpenCodeNativeSession {
  id: string;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface OpenCodeSessionBindingRecord extends RuntimeSessionBinding {
  title: string;
  createdAt: number;
  updatedAt: number;
}

export function isCurrentOpenCodeBinding(
  binding: OpenCodeSessionBindingRecord,
): boolean {
  return (
    binding.runtime.productId === OPENCODE_RUNTIME_IDENTITY.productId &&
    binding.runtime.installationId ===
      OPENCODE_RUNTIME_IDENTITY.installationId &&
    binding.runtime.adapterId === OPENCODE_RUNTIME_IDENTITY.adapterId &&
    binding.connectionId === OPENCODE_LOCAL_CONNECTION_ID
  );
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

function freezeOpenCodeBinding(
  binding: OpenCodeSessionBindingRecord,
): OpenCodeSessionBindingRecord {
  return Object.freeze({
    ...binding,
    runtime: Object.freeze({ ...binding.runtime }),
  });
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

export function startOpenCodeRuntime(
  options: OpenCodeStartOptions,
): Promise<OpenCodeRuntimeStatus> {
  return invoke("opencode_runtime_start", { options });
}

export function stopOpenCodeRuntime(): Promise<OpenCodeRuntimeStatus> {
  return invoke("opencode_runtime_stop");
}

export function openCodeProviderSnapshot(): Promise<OpenCodeProviderSnapshot> {
  return invoke("opencode_provider_snapshot");
}

export function createOpenCodeSession(
  title?: string,
): Promise<OpenCodeNativeSession> {
  return invoke<unknown>("opencode_session_create", {
    title: title?.trim() || null,
  }).then((value) => {
    const session = parseOpenCodeNativeSession(value);
    if (!session) throw new Error("OpenCode returned an invalid Session");
    return session;
  });
}

export function listOpenCodeSessions(): Promise<OpenCodeNativeSession[]> {
  return invoke<unknown[]>("opencode_session_list").then((sessions) =>
    sessions.flatMap((value) => {
      const session = parseOpenCodeNativeSession(value);
      return session ? [session] : [];
    }),
  );
}

export function listOpenCodeBindings(): Promise<
  OpenCodeSessionBindingRecord[]
> {
  return invoke<OpenCodeSessionBindingRecord[]>("opencode_binding_list").then(
    (bindings) => bindings.map(freezeOpenCodeBinding),
  );
}

export function rememberOpenCodeBinding(
  session: OpenCodeNativeSession,
): Promise<OpenCodeSessionBindingRecord> {
  return invoke<OpenCodeSessionBindingRecord>("opencode_binding_remember", {
    input: {
      nativeSessionId: session.id,
    },
  }).then(freezeOpenCodeBinding);
}

export function openCodeSessionMessages(
  sessionId: string,
  limit = 200,
): Promise<unknown[]> {
  return invoke("opencode_session_messages", { sessionId, limit });
}

export function promptOpenCode(input: OpenCodePromptInput): Promise<void> {
  return invoke("opencode_prompt_async", { input });
}

export function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  return invoke("opencode_session_abort", { sessionId });
}

export function respondToOpenCodePermission(
  input: OpenCodePermissionResponseInput,
): Promise<unknown> {
  return invoke("opencode_permission_respond", { input });
}

export function pollOpenCodeEvents(): Promise<OpenCodeEnvelope[]> {
  return invoke<Omit<OpenCodeEnvelope, "runtime">[]>(
    "opencode_runtime_poll_events",
  ).then((events) =>
    events.map((event) => ({
      ...event,
      runtime: OPENCODE_RUNTIME_IDENTITY,
    })),
  );
}

export function openCodeRuntimeDiagnostics(): Promise<string[]> {
  return invoke("opencode_runtime_diagnostics");
}
