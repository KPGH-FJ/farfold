import { invoke } from "@tauri-apps/api/core";
import type { CustomProviderInput } from "./capabilities";
import type { HostProviderProjectionSnapshot } from "./provider-projection";

export type ManagedApiKind = "openai-responses" | "openai-chat-completions";

export interface ManagedProviderInput {
  providerKey: string;
  label: string;
  accountLabel: string;
  endpoint: string;
  apiKind: ManagedApiKind;
  apiKey: string;
  modelId: string;
  modelName: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
}

export interface ManagedProviderSaveResult {
  providerConnectionId: string;
  currentConfigVersionId: string;
  providerKey: string;
  label: string;
  accountLabel: string;
  endpointFingerprint: string;
  credentialRevisionFingerprint: string;
  modelMappingFingerprint: string;
  projectionSnapshot: HostProviderProjectionSnapshot;
}

export interface ManagedProviderConnectionSummary {
  providerConnectionId: string;
  currentConfigVersionId: string | null;
  providerKey: string;
  label: string;
  accountLabel: string;
  endpoint: string;
  apiKind: ManagedApiKind;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  credentialRevisionFingerprint: string;
  updatedAt: number;
}

export interface ManagedProviderApplyResult {
  summary: ManagedProviderConnectionSummary;
  projectionSnapshot: HostProviderProjectionSnapshot;
}

export interface ManagedProviderCompatibilityCorrectionInput {
  providerConnectionId: string;
  providerConfigVersionId: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@+-]/g, "_").slice(0, 80) || "default";
}

function stablePreviewHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizeManagedProviderEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider endpoint must use http or https");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function tryNormalizeManagedProviderEndpoint(
  endpoint: string,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: normalizeManagedProviderEndpoint(endpoint) };
  } catch (reason) {
    return { ok: false, error: String(reason) };
  }
}

export function isOrdinaryZhipuChatCompletionsEndpoint(
  endpoint: string,
): boolean {
  const normalized = tryNormalizeManagedProviderEndpoint(endpoint);
  if (!normalized.ok) return false;
  const parsed = new URL(normalized.value);
  return (
    parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === "open.bigmodel.cn" &&
    parsed.port === "" &&
    parsed.pathname === "/api/paas/v4"
  );
}

export function normalizeManagedProviderCompatibility(
  input: ManagedProviderInput,
): ManagedProviderInput {
  if (
    input.apiKind === "openai-chat-completions" &&
    isOrdinaryZhipuChatCompletionsEndpoint(input.endpoint)
  ) {
    return { ...input, supportsDeveloperRole: false };
  }
  return input;
}

export function managedProviderConnectionId(input: {
  providerKey: string;
  endpoint: string;
  accountLabel: string;
}): string {
  const endpoint = normalizeManagedProviderEndpoint(input.endpoint);
  const hash = stablePreviewHash(
    [input.providerKey, endpoint, input.accountLabel].join("\0"),
  );
  return ["managed-provider", safeSegment(input.providerKey), hash].join("-");
}

export function managedProviderEndpointFingerprint(input: {
  providerKey: string;
  endpoint: string;
  apiKind: ManagedApiKind;
}): string {
  const endpoint = normalizeManagedProviderEndpoint(input.endpoint);
  return [
    "managed",
    safeSegment(input.apiKind),
    safeSegment(input.providerKey),
    safeSegment(endpoint),
  ].join(":");
}

export function managedProviderModelMappingFingerprint(input: {
  apiKind: ManagedApiKind;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}): string {
  return `model:${safeSegment(input.apiKind)}:${safeSegment(input.modelId)}:${input.contextWindow}:${input.maxTokens}`;
}

export function piCustomProviderInputFromManaged(
  input: ManagedProviderInput,
): CustomProviderInput {
  input = normalizeManagedProviderCompatibility(input);
  const api =
    input.apiKind === "openai-chat-completions"
      ? "openai-completions"
      : "openai-responses";
  return {
    providerId: managedProviderConnectionId(input),
    providerName: input.label,
    baseUrl: normalizeManagedProviderEndpoint(input.endpoint),
    api,
    modelId: input.modelId,
    modelName: input.modelName || input.modelId,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    reasoning: input.reasoning,
    imageInput: input.imageInput,
    localKeyless: false,
    supportsDeveloperRole: input.supportsDeveloperRole,
    supportsReasoningEffort: input.supportsReasoningEffort,
  };
}

export function saveManagedProviderApiKey(
  input: ManagedProviderInput,
): Promise<ManagedProviderSaveResult> {
  input = normalizeManagedProviderCompatibility(input);
  const endpoint = normalizeManagedProviderEndpoint(input.endpoint);
  return invoke("managed_provider_api_key_save", {
    input: {
      providerKey: input.providerKey,
      label: input.label,
      accountLabel: input.accountLabel,
      endpoint,
      apiKind: input.apiKind,
      apiKey: input.apiKey,
      modelId: input.modelId,
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      reasoning: input.reasoning,
      imageInput: input.imageInput,
      supportsDeveloperRole: input.supportsDeveloperRole,
      supportsReasoningEffort: input.supportsReasoningEffort,
    },
  });
}

export function listManagedProviderConnections(): Promise<
  ManagedProviderConnectionSummary[]
> {
  return invoke("managed_provider_connection_list");
}

export function correctOrdinaryZhipuDeveloperRole(
  input: ManagedProviderCompatibilityCorrectionInput,
): Promise<ManagedProviderSaveResult> {
  return invoke("managed_provider_correct_ordinary_zhipu_developer_role", {
    input,
  });
}

export function applyManagedProviderToOpenCodeServer(input: {
  providerConnectionId: string;
  providerConfigVersionId: string;
  operationId: string;
  runtimeProductId: "opencode";
  installationId: string;
  runtimeConnectionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
}): Promise<ManagedProviderApplyResult> {
  return invoke("managed_provider_apply_opencode_server", { input });
}

export function applyManagedProviderToPi(input: {
  providerConnectionId: string;
  providerConfigVersionId: string;
  operationId: string;
  runtimeProductId: "pi";
  installationId: string;
  runtimeConnectionId: string;
  runtimeProviderId: string;
  runtimeModelId: string;
}): Promise<ManagedProviderApplyResult> {
  return invoke("managed_provider_apply_pi", { input });
}
