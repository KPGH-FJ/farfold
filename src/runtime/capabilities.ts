import { invoke } from "@tauri-apps/api/core";

export type AuthType = "api_key" | "oauth";
export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderAuthMethod {
  type: AuthType;
  name: string;
  label?: string;
  subscription?: boolean;
  interactive: boolean;
}

export interface PiProvider {
  id: string;
  name: string;
  configured: boolean;
  source:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command"
    | null;
  sourceLabel: string | null;
  credentialType: AuthType | null;
  methods: ProviderAuthMethod[];
  modelCount: number;
}

export function resolveActiveProvider(
  providers: PiProvider[],
  modelProviderId: string | null,
): PiProvider | null {
  return (
    providers.find((provider) => provider.id === modelProviderId) ??
    providers.find((provider) => provider.configured) ??
    null
  );
}

export interface PiModel {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | number | null>>;
  thinkingLevels: ThinkingLevel[];
  available: boolean;
}

export interface PiSettingsSnapshot {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: ThinkingLevel | null;
  enabledModels: string[] | null;
}

export interface PiCapabilitySnapshot {
  sdkVersion: string;
  refreshedAt: number;
  providers: PiProvider[];
  models: PiModel[];
  customProviderIds: string[];
  orphanCredentials: Array<{ providerId: string; type: AuthType }>;
  settings: PiSettingsSnapshot;
}

export interface CustomProviderInput {
  providerId: string;
  providerName: string;
  baseUrl: string;
  api:
    | "openai-completions"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai";
  modelId: string;
  modelName: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  localKeyless: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
}

export type AuthPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
    }
  | {
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    };

export type AuthNotice =
  | {
      type: "info";
      message: string;
      links?: Array<{ url: string; label?: string }>;
    }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type CapabilityEvent =
  | {
      type: "response";
      id: string;
      command: string;
      success: boolean;
      data?: unknown;
      error?: string;
    }
  | {
      type: "auth_prompt";
      requestId: string;
      promptId: string;
      providerId: string;
      prompt: AuthPrompt;
    }
  | {
      type: "auth_event";
      requestId: string;
      providerId: string;
      event: AuthNotice;
    }
  | { type: "bridge_error"; error: string }
  | { type: "bridge_lifecycle"; state: "closed" };

type CapabilityCommand =
  | { type: "snapshot"; projectPath: string | null }
  | { type: "refresh"; projectPath: string | null }
  | { type: "login"; providerId: string; authType: AuthType }
  | {
      type: "auth_response";
      requestId: string;
      promptId: string;
      value: string;
    }
  | { type: "auth_cancel"; requestId: string }
  | { type: "test_connection"; providerId: string }
  | ({
      type: "upsert_custom_provider";
      projectPath: string | null;
    } & CustomProviderInput)
  | { type: "logout"; providerId: string }
  | {
      type: "set_defaults";
      providerId: string;
      modelId: string;
      thinkingLevel?: ThinkingLevel;
      projectPath: string | null;
    };

let sequence = 0;
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function requestId(): string {
  sequence += 1;
  return `capability-${Date.now()}-${sequence}`;
}

export function startCapabilities(): Promise<void> {
  return invoke("pi_capabilities_start");
}

export function pollCapabilityEvents(): Promise<CapabilityEvent[]> {
  return invoke("pi_capabilities_poll");
}

function request<T>(
  command: CapabilityCommand,
  timeout = command.type === "login" ? 10 * 60_000 : 45_000,
): Promise<T> {
  const id = requestId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Pi capability 请求超时：${command.type}`));
    }, timeout);
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    void invoke("pi_capabilities_send", { command: { ...command, id } }).catch(
      (reason) => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      },
    );
  });
}

export function settleCapabilityEvent(event: CapabilityEvent): boolean {
  if (event.type !== "response") return false;
  const entry = pending.get(event.id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(event.id);
  if (event.success) entry.resolve(event.data);
  else entry.reject(new Error(event.error || "Pi capability 请求失败"));
  return true;
}

export function rejectCapabilityRequests(reason: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

export function getCapabilitySnapshot(
  projectPath: string | null,
): Promise<PiCapabilitySnapshot> {
  return request({ type: "snapshot", projectPath });
}

export async function refreshCapabilitySnapshot(
  projectPath: string | null,
): Promise<PiCapabilitySnapshot> {
  const result = await request<{ snapshot: PiCapabilitySnapshot }>({
    type: "refresh",
    projectPath,
  });
  return result.snapshot;
}

export function loginProvider(
  providerId: string,
  authType: AuthType,
): Promise<{ providerId: string; credentialType: AuthType }> {
  return request({ type: "login", providerId, authType });
}

export function respondToAuthPrompt(
  requestIdValue: string,
  promptId: string,
  value: string,
): Promise<{ accepted: boolean }> {
  return request({
    type: "auth_response",
    requestId: requestIdValue,
    promptId,
    value,
  });
}

export function cancelProviderLogin(requestIdValue: string): Promise<void> {
  return request({ type: "auth_cancel", requestId: requestIdValue });
}

export function logoutProvider(providerId: string): Promise<void> {
  return request({ type: "logout", providerId });
}

export function testProviderConnection(providerId: string): Promise<{
  providerId: string;
  model: { provider: string; id: string; name: string };
  checkedAt: number;
}> {
  return request({ type: "test_connection", providerId }, 35_000);
}

export function upsertCustomProvider(
  input: CustomProviderInput,
  projectPath: string | null,
): Promise<PiCapabilitySnapshot> {
  return request({
    type: "upsert_custom_provider",
    ...input,
    projectPath,
  });
}

export function setDefaultModel(
  providerId: string,
  modelId: string,
  thinkingLevel: ThinkingLevel | undefined,
  projectPath: string | null,
): Promise<PiSettingsSnapshot> {
  return request({
    type: "set_defaults",
    providerId,
    modelId,
    thinkingLevel,
    projectPath,
  });
}
