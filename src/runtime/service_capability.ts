import type { ServiceCapability } from "./credentials";

export type ApiConfigurationState = "unknown" | "supported" | "unsupported";

/** Only a completed declaration can establish the absence of a route. */
export function apiConfigurationState(
  capability: Pick<ServiceCapability, "apiTypes"> | null | undefined,
): ApiConfigurationState {
  if (!capability || !Array.isArray(capability.apiTypes)) return "unknown";
  return capability.apiTypes.length ? "supported" : "unsupported";
}
