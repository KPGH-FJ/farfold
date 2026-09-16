import { describe, expect, it } from "vitest";
import {
  managedProviderConnectionId,
  managedProviderEndpointFingerprint,
  managedProviderModelMappingFingerprint,
  normalizeManagedProviderCompatibility,
  normalizeManagedProviderEndpoint,
  piCustomProviderInputFromManaged,
  tryNormalizeManagedProviderEndpoint,
} from "./managed-provider";

const explicitCapabilities = {
  reasoning: false,
  imageInput: false,
  supportsDeveloperRole: true,
  supportsReasoningEffort: false,
};

describe("managed Provider contract", () => {
  it("forces the ordinary Zhipu endpoint to use system role without changing peer endpoints", () => {
    const ordinary = {
      providerKey: "zai",
      label: "Zhipu BigModel",
      accountLabel: "default",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/",
      apiKind: "openai-chat-completions" as const,
      apiKey: "fixture-only",
      modelId: "glm-4.6v",
      modelName: "GLM-4.6V",
      contextWindow: 128_000,
      maxTokens: 8_192,
      reasoning: true,
      imageInput: true,
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
    };

    expect(normalizeManagedProviderCompatibility(ordinary)).toEqual({
      ...ordinary,
      supportsDeveloperRole: false,
    });
    expect(
      normalizeManagedProviderCompatibility({
        ...ordinary,
        endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
      }).supportsDeveloperRole,
    ).toBe(true);
    expect(
      normalizeManagedProviderCompatibility({
        ...ordinary,
        endpoint: "https://example.com/v1",
      }).supportsDeveloperRole,
    ).toBe(true);
  });

  it("derives account-instance connection ids instead of provider-brand ids", () => {
    const base = {
      providerKey: "openai",
      endpoint: "https://api.openai.com/v1/",
    };
    expect(
      managedProviderConnectionId({ ...base, accountLabel: "work" }),
    ).not.toBe(
      managedProviderConnectionId({ ...base, accountLabel: "personal" }),
    );
    expect(
      managedProviderConnectionId({ ...base, accountLabel: "work" }),
    ).not.toBe(
      managedProviderConnectionId({
        providerKey: "openai",
        endpoint: "https://proxy.example.test/v1",
        accountLabel: "work",
      }),
    );
  });

  it("removes URL credentials from endpoint identity and never uses the api key", () => {
    expect(
      normalizeManagedProviderEndpoint(
        "https://user:secret@example.test/v1/#token",
      ),
    ).toBe("https://example.test/v1");
    const fingerprint = managedProviderEndpointFingerprint({
      providerKey: "openai",
      endpoint: "https://user:secret@example.test/v1/",
      apiKind: "openai-responses",
    });
    expect(fingerprint).not.toContain("secret");
    expect(fingerprint).not.toContain("user");
  });

  it("maps the shared entry into Pi custom provider config without a secret", () => {
    const input = piCustomProviderInputFromManaged({
      providerKey: "openai",
      label: "OpenAI Work",
      accountLabel: "work",
      endpoint: "https://api.openai.com/v1",
      apiKind: "openai-responses",
      apiKey: "sk-test",
      modelId: "gpt-5.6-sol",
      modelName: "GPT 5.6 Sol",
      contextWindow: 200000,
      maxTokens: 16000,
      ...explicitCapabilities,
    });
    expect(input.api).toBe("openai-responses");
    expect(input.localKeyless).toBe(false);
    expect(input.providerId).toContain("managed-provider-openai");
    expect(JSON.stringify(input)).not.toContain("sk-test");
  });

  it("maps shared Chat Completions connections into Pi openai-completions config", () => {
    const input = piCustomProviderInputFromManaged({
      providerKey: "openai",
      label: "OpenAI Work",
      accountLabel: "work",
      endpoint: "https://api.openai.com/v1",
      apiKind: "openai-chat-completions",
      apiKey: "sk-test",
      modelId: "gpt-5.6-sol",
      modelName: "GPT 5.6 Sol",
      contextWindow: 200000,
      maxTokens: 16000,
      reasoning: true,
      imageInput: true,
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
    });
    expect(input.api).toBe("openai-completions");
    expect(input.reasoning).toBe(true);
    expect(input.imageInput).toBe(true);
    expect(input.supportsReasoningEffort).toBe(true);
    expect(JSON.stringify(input)).not.toContain("sk-test");
  });

  it("does not collapse labels or endpoints that sanitize to the same text", () => {
    const base = { providerKey: "openai", endpoint: "https://api.test/v1" };
    expect(
      managedProviderConnectionId({ ...base, accountLabel: "账号/一" }),
    ).not.toBe(
      managedProviderConnectionId({ ...base, accountLabel: "账号_一" }),
    );
    expect(
      managedProviderConnectionId({
        providerKey: "openai",
        endpoint: `https://api.test/${"a".repeat(120)}/one`,
        accountLabel: "work",
      }),
    ).not.toBe(
      managedProviderConnectionId({
        providerKey: "openai",
        endpoint: `https://api.test/${"a".repeat(120)}/two`,
        accountLabel: "work",
      }),
    );
  });

  it("offers a non-throwing endpoint validation helper for live forms", () => {
    expect(tryNormalizeManagedProviderEndpoint("not a url").ok).toBe(false);
    expect(tryNormalizeManagedProviderEndpoint("https://api.test/v1")).toEqual({
      ok: true,
      value: "https://api.test/v1",
    });
  });

  it("keeps same-name models distinct through connection scoped provider ids", () => {
    const model = managedProviderModelMappingFingerprint({
      apiKind: "openai-responses",
      modelId: "gpt-shared",
      contextWindow: 200000,
      maxTokens: 16000,
    });
    expect(model).toBe("model:openai-responses:gpt-shared:200000:16000");
    expect(
      piCustomProviderInputFromManaged({
        providerKey: "openai",
        label: "OpenAI US",
        accountLabel: "us",
        endpoint: "https://api.openai.com/v1",
        apiKind: "openai-responses",
        apiKey: "secret-a",
        modelId: "gpt-shared",
        modelName: "GPT Shared",
        contextWindow: 200000,
        maxTokens: 16000,
        ...explicitCapabilities,
      }).providerId,
    ).not.toBe(
      piCustomProviderInputFromManaged({
        providerKey: "openai",
        label: "OpenAI EU",
        accountLabel: "eu",
        endpoint: "https://eu.example.test/v1",
        apiKind: "openai-responses",
        apiKey: "secret-b",
        modelId: "gpt-shared",
        modelName: "GPT Shared",
        contextWindow: 200000,
        maxTokens: 16000,
        ...explicitCapabilities,
      }).providerId,
    );
  });
});
