import { describe, expect, it } from "vitest";
import { filterModels, formatTokenCount, modelKey } from "./ModelPicker";
import type { PiModel } from "../runtime/capabilities";

const model = {
  provider: "openai",
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_000,
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
  available: true,
} satisfies PiModel;

describe("ModelPicker model truth helpers", () => {
  it("keeps provider and model ids unambiguous", () => {
    expect(modelKey(model)).toBe("openai\u0000gpt-test");
  });

  it("searches the full Pi model identity and API", () => {
    expect(filterModels([model], "responses")).toEqual([model]);
    expect(filterModels([model], "anthropic")).toEqual([]);
  });

  it("formats capability metadata without hiding the exact model id", () => {
    expect(formatTokenCount(model.contextWindow)).toBe("128K");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });
});
