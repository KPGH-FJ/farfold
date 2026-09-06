import { describe, expect, it } from "vitest";
import { modelValidation, validationFromMessage } from "./provider-validation";

describe("model-scoped request evidence", () => {
  it("does not carry another model's success or failure to the selected model", () => {
    const result = validationFromMessage({
      role: "assistant",
      provider: "zai",
      model: "chosen",
      stopReason: "stop",
    })!;
    expect(modelValidation(result.validation, "chosen")?.state).toBe(
      "verified-success",
    );
    expect(modelValidation(result.validation, "other")).toBeUndefined();
  });

  it.each([
    {
      role: "assistant",
      provider: "zai",
      model: "chosen",
      stopReason: "error",
      errorMessage: "The operation was aborted.",
    },
    {
      role: "assistant",
      provider: "zai",
      model: "chosen",
      stopReason: "aborted",
    },
    { role: "assistant", stopReason: "stop" },
    { role: "user", provider: "zai", model: "chosen", stopReason: "stop" },
    {
      role: "assistant",
      provider: "zai",
      model: "chosen",
      stopReason: "unknown",
    },
  ])(
    "does not invent validation from incomplete, cancelled, or non-assistant messages",
    (message) => {
      expect(validationFromMessage(message)).toBeNull();
    },
  );

  it("keeps native failed-model identity and the failure reason", () => {
    const result = validationFromMessage({
      role: "assistant",
      provider: "zai",
      model: "denied",
      stopReason: "error",
      errorMessage: "403 model access denied",
    })!;
    expect(result.providerId).toBe("zai");
    expect(result.validation.modelId).toBe("denied");
    expect(result.validation.state).toBe("verified-failure");
    expect(modelValidation(result.validation, "chosen")).toBeUndefined();
  });
});
