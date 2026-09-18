import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resolveActiveProvider, type PiProvider } from "./capabilities";

const providers: PiProvider[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    configured: true,
    source: "stored",
    sourceLabel: null,
    credentialType: "api_key",
    methods: [],
    modelCount: 3,
  },
  {
    id: "zai",
    name: "Z.AI",
    configured: true,
    source: "stored",
    sourceLabel: null,
    credentialType: "api_key",
    methods: [],
    modelCount: 7,
  },
];

describe("Provider projection truth", () => {
  it("uses the current or default model provider instead of the first configured provider", () => {
    expect(resolveActiveProvider(providers, "zai")?.id).toBe("zai");
  });

  it("falls back to a configured provider when no model is known", () => {
    expect(resolveActiveProvider(providers, null)?.id).toBe("deepseek");
  });
});
