import type {
  PluginItem,
  PluginOperation,
  PluginRequest,
  PluginSourceItem,
} from "./plugin_management_types";
export const pluginItem: PluginItem = {
  id: 0,
  name: "controlled-package",
  marketplaceName: "controlled-source",
  version: "1.0",
  reportedInstalled: false,
  reportedEnabled: false,
  source: "local",
  installPolicy: "available",
  authPolicy: "onUse",
  install: { availability: "available", reason: null },
  remove: { availability: "unavailable", reason: "notInstalled" },
};
export const pluginSource: PluginSourceItem = {
  id: 0,
  name: "controlled-source",
  kind: "local",
  query: { availability: "available", reason: null },
};
export function pluginOperation(
  request: PluginRequest,
  ready = false,
): PluginOperation {
  return {
    agentId: request.agentId,
    requestId: request.requestId,
    cwd: request.cwd,
    action: request.action,
    state: ready ? "ready" : "running",
    phase: ready ? "complete" : "reading",
    settled: ready,
    code: null,
    writeDispatched: false,
    writeAck: "none",
    outcome: null,
    target: request.target ?? null,
    catalog:
      ready && request.action === "inventory"
        ? {
            observedAtMs: Date.now(),
            scope: "officialSharedPluginConfiguration",
            source: "officialCli",
            complete: false,
            sessionApplicability: "unverified",
            items: [structuredClone(pluginItem)],
          }
        : null,
    review:
      ready && request.action === "inspect"
        ? {
            reviewId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            agentId: request.agentId,
            cwd: request.cwd,
            target: request.target!,
            install: request.install!,
            observedAtMs: Date.now(),
            validForMs: 300000,
            scope: "officialSharedPluginConfiguration",
            sessionApplicability: "unverified",
          }
        : null,
    observation: null,
    ...(ready && request.action === "sources"
      ? {
          sources: {
            observedAtMs: Date.now(),
            scope: "officialSharedPluginConfiguration" as const,
            source: "officialCli" as const,
            complete: false as const,
            sessionApplicability: "unverified" as const,
            items: [structuredClone(pluginSource)],
          },
        }
      : {}),
  };
}
export const pluginTicket = "11111111-1111-1111-1111-111111111111";
