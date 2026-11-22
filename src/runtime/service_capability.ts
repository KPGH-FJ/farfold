import { credentialEndpointIssue } from "./credential_editor";
import type { Credential, ServiceCapability } from "./credentials";
import { R5_SERVICE_STRINGS as S } from "./r5_service_strings";
import { STRINGS } from "./strings";

export type ApiConfigurationState = "unknown" | "supported" | "unsupported";

/** Only a completed declaration can establish the absence of a route. */
export function apiConfigurationState(
  capability: Pick<ServiceCapability, "apiTypes"> | null | undefined,
): ApiConfigurationState {
  if (!capability || !Array.isArray(capability.apiTypes)) return "unknown";
  return capability.apiTypes.length ? "supported" : "unsupported";
}

const formatLabel = (apiType: string) =>
  Object.entries(STRINGS.credentials.formats).find(
    ([id]) => id === apiType,
  )?.[1] ?? apiType;

/** Both pickers call this only after loading a supported Agent with no selectable service. */
export function emptyServiceGuidance(
  capability: ServiceCapability,
  items: Credential[],
): { message: string; add: boolean } {
  const saved = items.filter((item) => item.purpose !== "authentication");
  const formats = S.supportedFormats(
    capability.apiTypes.map(formatLabel).join("、"),
  );
  if (!saved.length) return { message: S.noSavedServices + formats, add: true };
  const active = saved.filter((item) => !item.deleting);
  if (!active.length) return { message: S.removingServices, add: false };

  const complete = active.filter(
    (item) => item.complete && item.revision && item.models.length,
  );
  const messages: string[] = [];
  if (complete.length < active.length) messages.push(S.incompleteServices);
  if (complete.some((item) => !capability.apiTypes.includes(item.apiType)))
    messages.push(S.differentFormat);
  if (messages.length) messages.push(formats);

  const addressMismatches = complete.filter(
    (item) =>
      capability.apiTypes.includes(item.apiType) &&
      !canUseService(capability, item),
  );
  for (const apiType of new Set(
    addressMismatches.map((item) => item.apiType),
  )) {
    const choices = new Set<string>();
    for (const rule of capability.endpointRules ?? []) {
      if (rule.apiType !== apiType) continue;
      if (/^\/[a-zA-Z0-9._~/-]*$/.test(rule.requiredPathSuffix))
        choices.add(S.pathEnding(rule.requiredPathSuffix));
      for (const endpoint of rule.allowedExactEndpoints) {
        if (!credentialEndpointIssue(endpoint))
          choices.add(S.exactAddress(endpoint));
      }
    }
    messages.push(
      S.addressMismatch(formatLabel(apiType), [...choices].join("，或")),
    );
  }
  return { message: messages.join("") || formats, add: false };
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
