import { Channel, invoke } from "@tauri-apps/api/core";
import type { InstallProgress } from "./agents";
import { PREPARATION_STRINGS as S } from "./preparation_strings";

export interface AgentDependency {
  id: string;
  name: string;
  status: "ready" | "missing" | "failed";
  detail?: string | null;
  sourceUrl: string;
  installable: boolean;
  managedLocation: string;
  checkCommand: string;
}

export interface PreparationLink {
  label: string;
  url: string;
  kind: "account" | "documentation";
  methodIds?: string[];
  description?: string;
}

export interface PreparationInfo {
  dependencies: AgentDependency[];
  links: PreparationLink[];
}

export const getAgentPreparation = (agentId: string) =>
  invoke<PreparationInfo>("agent_preparation", { agentId });

interface ActiveInstall {
  requestId: string;
  settled: boolean;
  started: boolean;
  cancelled: boolean;
  cancelBeforeStart: boolean;
  pending: Set<Promise<void>>;
}
const activeInstalls = new Map<string, ActiveInstall>();

function cancelOwned(agentId: string, operation: ActiveInstall): Promise<void> {
  if (operation.settled) return Promise.resolve();
  operation.cancelled = true;
  if (!operation.started) operation.cancelBeforeStart = true;
  const pending = invoke<void>("agent_dependency_cancel", {
    agentId,
    requestId: operation.requestId,
  });
  operation.pending.add(pending);
  void pending
    .finally(() => operation.pending.delete(pending))
    .catch(() => undefined);
  return pending;
}

export async function installAgentDependency(
  agentId: string,
  dependencyId: string,
  progress: (value: InstallProgress) => void,
): Promise<PreparationInfo> {
  if (activeInstalls.has(agentId)) throw new Error(S.alreadyInstalling);
  const operation: ActiveInstall = {
    requestId: crypto.randomUUID(),
    settled: false,
    started: false,
    cancelled: false,
    cancelBeforeStart: false,
    pending: new Set(),
  };
  activeInstalls.set(agentId, operation);
  const onProgress = new Channel<InstallProgress>();
  onProgress.onmessage = (value) => {
    if (operation.settled) return;
    const first = !operation.started;
    operation.started = true;
    if (first && operation.cancelled && operation.cancelBeforeStart)
      void cancelOwned(agentId, operation).catch(() => undefined);
    progress(value);
  };
  try {
    return await invoke<PreparationInfo>("agent_dependency_install", {
      agentId,
      dependencyId,
      requestId: operation.requestId,
      onProgress,
    });
  } finally {
    operation.settled = true;
    await Promise.allSettled([...operation.pending]);
    if (activeInstalls.get(agentId) === operation)
      activeInstalls.delete(agentId);
  }
}

export function cancelDependencyInstall(agentId: string): Promise<void> {
  const operation = activeInstalls.get(agentId);
  return operation ? cancelOwned(agentId, operation) : Promise.resolve();
}

export function officialLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function accountLinksForMethod(
  links: PreparationLink[],
  methodId?: string,
): PreparationLink[] {
  return links.filter(
    (item) =>
      officialLink(item.url) &&
      (!item.methodIds?.length ||
        (!!methodId && item.methodIds.includes(methodId))),
  );
}
