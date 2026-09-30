import {
  authenticationFolder,
  invalidateAuthenticationEvidence,
} from "./authentication-state.js";

// These are observations for a selected model, not an account-wide statement.
// Effort, a cosmetic service rename, or a reconnect cannot erase an explicit
// model entitlement failure. A changed service/key is a different selection.
export function entitlementScopeKey(agent, selection = {}, service) {
  const access =
    selection.access ||
    selection.accessMode ||
    (selection.serviceId ? "api" : "existing");
  const api = access === "api";
  return JSON.stringify([
    agent?.id || selection.agentId || agent?.name || selection.agent || "",
    authenticationFolder(selection.folder),
    api ? "api" : "existing",
    api ? service?.id || selection.serviceId || "" : null,
    api
      ? (service?.secretRevision ??
        selection.secretRevision ??
        selection.serviceSnapshot?.secretRevision ??
        0)
      : null,
    selection.model || "",
  ]);
}
export const entitlementIssue = (agent, selection, service) =>
  agent?.entitlementFailures?.some(
    (failure) => failure.key === entitlementScopeKey(agent, selection, service),
  )
    ? "这次选择已返回权限或额度不足。处理后请重新检查，或明确选择另一个模型或来源。"
    : null;
export const entitlementRetryAllowed = (agent, selection, service) =>
  !!agent?.entitlementRetryKeys?.includes(
    entitlementScopeKey(agent, selection, service),
  );
export function entitlementCheckIssue(agent, selection, service) {
  return entitlementRetryAllowed(agent, selection, service)
    ? null
    : entitlementIssue(agent, selection, service);
}
export function rememberEntitlementFailure(agent, selection, service) {
  const key = entitlementScopeKey(agent, selection, service);
  return {
    ...agent,
    setupComplete: false,
    demoReady: false,
    setupEvidence: null,
    entitlementFailures: [
      ...(agent.entitlementFailures || []).filter(
        (failure) => failure.key !== key,
      ),
      { key },
    ],
    entitlementRetryKeys: (agent.entitlementRetryKeys || []).filter(
      (item) => item !== key,
    ),
  };
}
export function markEntitlementForRetry(agent, selection, service) {
  if (agent.accessJob || !entitlementIssue(agent, selection, service))
    return agent;
  const key = entitlementScopeKey(agent, selection, service);
  return {
    ...invalidateAuthenticationEvidence(agent),
    entitlementRetryKeys: [
      ...new Set([...(agent.entitlementRetryKeys || []), key]),
    ],
  };
}
export function clearEntitlementFailure(agent, selection, service) {
  const key = entitlementScopeKey(agent, selection, service);
  return {
    ...agent,
    entitlementFailures: (agent.entitlementFailures || []).filter(
      (failure) => failure.key !== key,
    ),
    entitlementRetryKeys: (agent.entitlementRetryKeys || []).filter(
      (item) => item !== key,
    ),
  };
}
