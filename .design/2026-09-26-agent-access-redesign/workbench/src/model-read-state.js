export const modelReadScope = (agent, selection = {}) =>
  JSON.stringify([
    agent.id,
    agent.selectedInstallationId,
    agent.programRevision || 0,
    agent.connectionRevision || 0,
    selection.folder || "",
    selection.access || "existing",
    selection.serviceId || "",
  ]);
export function beginModelRead(agent, selection, outcome = "choices") {
  if (
    !agent.connected ||
    agent.accessJob ||
    (agent.modelCatalog?.status === "loading" &&
      agent.modelCatalog.scope === modelReadScope(agent, selection))
  )
    return agent;
  return {
    ...agent,
    modelCatalog: {
      scope: modelReadScope(agent, selection),
      status: "loading",
      outcome,
      values: [...currentModelOptions(agent, selection)],
    },
  };
}
export function finishModelRead(agent, selection, expectedScope) {
  const read = agent.modelCatalog;
  if (
    !agent.connected ||
    agent.accessJob ||
    read?.status !== "loading" ||
    read.scope !== expectedScope ||
    modelReadScope(agent, selection) !== expectedScope
  )
    return agent;
  if (read.outcome === "failure")
    return { ...agent, modelCatalog: { ...read, status: "failed" } };
  return {
    ...agent,
    modelCatalog: {
      ...read,
      status: read.outcome === "none" ? "not-provided" : "ready",
      values:
        read.outcome === "none"
          ? []
          : read.values.length
            ? read.values
            : ["演示模型 A", "演示模型 B"],
      demo: true,
    },
  };
}
export function currentModelOptions(agent, selection) {
  const read = agent.modelCatalog;
  // A refresh or its failure is not evidence that the last known list changed.
  // Only the matching program/connection/selection can reuse these options.
  return read?.scope === modelReadScope(agent, selection) &&
    ["ready", "not-provided", "loading", "failed"].includes(read.status) &&
    Array.isArray(read.values)
    ? read.values
    : agent.models || [];
}
