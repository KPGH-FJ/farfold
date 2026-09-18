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
