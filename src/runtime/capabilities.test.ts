import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  resolveActiveProvider,
  loginProvider,
  settleCapabilityEvent,
  PiLoginCancelled,
  type PiProvider,
} from "./capabilities";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

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

describe("Pi login result evidence", () => {
  it.each([true, false])(
    "only treats an explicit native cancellation flag as cancelled (%s)",
    async (cancelled) => {
      vi.mocked(invoke).mockClear();
      const result = loginProvider("zai", "api_key");
      const assertion = cancelled
        ? expect(result).rejects.toBeInstanceOf(PiLoginCancelled)
        : expect(result).rejects.not.toBeInstanceOf(PiLoginCancelled);
      const { command } = vi.mocked(invoke).mock.calls[0][1] as {
        command: { id: string };
      };
      settleCapabilityEvent({
        type: "response",
        id: command.id,
        command: "login",
        success: false,
        cancelled,
        error: "This operation was aborted",
      });
      await assertion;
    },
  );
});
