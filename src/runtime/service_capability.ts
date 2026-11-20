import { credentialEndpointIssue } from "./credential_editor";
import type { Credential, ServiceCapability } from "./credentials";

export type ApiConfigurationState = "unknown" | "supported" | "unsupported";

/** Only a completed declaration can establish the absence of a route. */
export function apiConfigurationState(
  capability: Pick<ServiceCapability, "apiTypes"> | null | undefined,
): ApiConfigurationState {
  if (!capability || !Array.isArray(capability.apiTypes)) return "unknown";
  return capability.apiTypes.length ? "supported" : "unsupported";
}

/** Only formats with a declared endpoint rule restrict the saved base address. */
export function canUseService(
  capability:
    Pick<ServiceCapability, "apiTypes" | "endpointRules"> | null | undefined,
  service: Pick<Credential, "apiType" | "endpoint">,
): boolean {
  if (!capability?.apiTypes.includes(service.apiType)) return false;
  const rules = capability.endpointRules?.filter(
    ({ apiType }) => apiType === service.apiType,
  );
  if (!rules?.length) return true;
  if (credentialEndpointIssue(service.endpoint)) return false;
  const url = new URL(service.endpoint.trim());
  const canonical = (value: string) => value.replace(/\/+$/, "");
  const path = canonical(url.pathname);
  const exactEndpoint = canonical(url.href);
  return rules.some(
    ({ requiredPathSuffix, allowedExactEndpoints }) =>
      (requiredPathSuffix.startsWith("/") &&
        path.endsWith(requiredPathSuffix)) ||
      allowedExactEndpoints.some(
        (value) =>
          !credentialEndpointIssue(value) &&
          canonical(new URL(value.trim()).href) === exactEndpoint,
      ),
  );
}
