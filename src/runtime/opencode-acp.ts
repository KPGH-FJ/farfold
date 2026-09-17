import { invoke } from "@tauri-apps/api/core";
import type { RuntimeIdentity } from "./adapter";

export const OPENCODE_ACP_ADAPTER_ID = "opencode-acp-stdio-v1";

export interface OpenCodeAcpStatus {
  state: "stopped" | "running";
  running: boolean;
  /** A native Session is bound to this connection and can accept prompts. */
  ready: boolean;
  generation: number;
  runtime: RuntimeIdentity;
  runtimeBuildId: string;
  runtimeConnectionId: string;
  cwd: string | null;
  binaryPath: string | null;
  agentName: string | null;
  agentVersion: string | null;
  protocolVersion: number | null;
  questionBridge: boolean;
  loadSession: boolean;
  configOptions: unknown;
  managedProvider: {
    providerConnectionId: string;
    providerConfigVersionId: string;
    runtimeProviderId: string;
    runtimeModelId: string;
  } | null;
  sessionId: string | null;
  lastError: string | null;
  droppedEvents: number;
  initializedAtMs: number | null;
}

export function openCodeAcpStatus(): Promise<OpenCodeAcpStatus> {
  return invoke("opencode_acp_status");
}

export function submitOpenCodeAcpTurn(input: {
  farfoldSessionId: string;
  nativeSessionId: string;
  providerConnectionId?: string;
  providerConfigVersionId?: string;
  runtimeProviderId?: string;
  runtimeModelId?: string;
  text: string;
}): Promise<
  | { outcome: "accepted"; submission: unknown }
  | { outcome: "cancelled"; detail: string }
  | { outcome: "failed"; detail: string }
  | { outcome: "unknown"; detail: string }
> {
  return invoke("host_opencode_acp_turn_submit", { input });
}

export function abortOpenCodeAcpTurn(input: {
  farfoldSessionId: string;
  nativeSessionId: string;
}): Promise<boolean> {
  return invoke("host_opencode_acp_turn_abort", { input });
}

export function respondToOpenCodeAcpPermission(input: {
  farfoldSessionId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
  requestId: string;
  optionId: string;
}): Promise<unknown> {
  return invoke("opencode_acp_permission_respond", { input });
}

export function respondToOpenCodeAcpQuestion(input: {
  farfoldSessionId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | string[]>;
}): Promise<unknown> {
  return invoke("opencode_acp_question_respond", { input });
}

export function setOpenCodeAcpConfigOption(input: {
  farfoldSessionId: string;
  nativeSessionId: string;
  configId: string;
  value: string | boolean;
  valueType?: "boolean";
}): Promise<OpenCodeAcpStatus> {
  return invoke("opencode_acp_set_config_option", { input });
}
