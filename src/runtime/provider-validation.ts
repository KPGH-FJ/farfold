import { formatProviderError, piInterruptionMessage } from "./conversation";

export interface ProviderValidation {
  state: "verified-success" | "verified-failure";
  checkedAt: number;
  modelId: string;
  modelName?: string;
  error?: string;
}

export function modelValidation(
  validation: ProviderValidation | undefined,
  modelId: string | undefined,
): ProviderValidation | undefined {
  return modelId && validation?.modelId === modelId ? validation : undefined;
}

export function validationFromMessage(
  message: Record<string, unknown> | null,
): {
  providerId: string;
  validation: ProviderValidation;
} | null {
  if (
    message?.role !== "assistant" ||
    piInterruptionMessage(message) !== null ||
    typeof message.provider !== "string" ||
    !message.provider ||
    typeof message.model !== "string" ||
    !message.model ||
    !["stop", "length", "toolUse", "error"].includes(String(message.stopReason))
  )
    return null;
  const failed =
    message.stopReason === "error" || typeof message.errorMessage === "string";
  return {
    providerId: message.provider,
    validation: {
      state: failed ? "verified-failure" : "verified-success",
      checkedAt: Date.now(),
      modelId: message.model,
      ...(failed && typeof message.errorMessage === "string"
        ? { error: formatProviderError(message.errorMessage) }
        : {}),
    },
  };
}
