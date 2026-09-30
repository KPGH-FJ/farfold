// Review state for the boundary with the Agent's official account or setup
// interaction. No provider menu, registration result, credential, or entitlement
// is inferred from opening or returning from that interaction.
export function beginOfficialHandoff(route, method) {
  const selection = route?.interaction?.serviceSelection;
  const agentOwned =
    selection === "agent-owned" ||
    (!selection && ["setup", "service"].includes(method?.purpose));
  const account =
    !agentOwned &&
    (selection === "fixed-account" ||
      route?.purpose === "login" ||
      method?.purpose === "login" ||
      method?.type === "agent" ||
      !!method?.accountLabel);
  return {
    mode: account ? "account" : "service",
    stage: "ready",
    account: account
      ? route?.accountOwner || method?.accountLabel || null
      : null,
    routeId: route?.id || null,
    methodId: method?.id || null,
  };
}

export function transitionOfficialHandoff(flow, action) {
  if (!flow || !["account", "service"].includes(flow.mode)) return flow;
  if (action === "open" && ["ready", "waiting"].includes(flow.stage))
    return { ...flow, stage: "external" };
  if (action === "return" && flow.stage === "external")
    return { ...flow, stage: "waiting" };
  if (
    action === "approve" &&
    flow.mode === "account" &&
    flow.stage === "external"
  )
    return { ...flow, stage: "confirmed" };
  if (
    action === "settings-returned" &&
    flow.mode === "service" &&
    flow.stage === "external"
  )
    return { ...flow, stage: "returned" };
  return flow;
}

export function canFinishOfficialHandoff(flow) {
  return !!(
    (flow?.mode === "account" && flow.stage === "confirmed") ||
    (flow?.mode === "service" && flow.stage === "returned")
  );
}
