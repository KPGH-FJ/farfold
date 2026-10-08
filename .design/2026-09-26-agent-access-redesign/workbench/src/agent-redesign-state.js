import { authenticationFolder } from "./authentication-state.js";
import { normalizeAgent } from "./agent-setup-state.js";
import {
  programAction,
  startAgentJob,
  installationReferenceIssue,
} from "./access-jobs.js";

// UI orchestration only. Existing job guards still own completion and cancellation.
export function needsAutomaticProgramCheck(input, busyCount = 0) {
  const agent = normalizeAgent(input);
  return !!(
    agent.installed &&
    agent.registered &&
    !agent.removed &&
    !agent.dependenciesMissing &&
    !agent.connected &&
    !agent.accessJob &&
    !busyCount &&
    agent.connectionState === "idle"
  );
}

export function startProgramChange(input, type, options = {}) {
  const agent = normalizeAgent(input);
  if (
    options.busyCount ||
    agent.accessJob ||
    agent.connectionState === "unknown"
  )
    return input;
  const idle = agent.connected ? programAction(agent, "disconnect") : agent;
  return startAgentJob(idle, type, options);
}

export function removableInstallations(agent, allAgents = []) {
  return (agent.installations || []).filter(
    (item) =>
      item.managed &&
      !item.inUse &&
      !installationReferenceIssue(agent, item, allAgents),
  );
}

export function uninstallUnusedProgram(
  input,
  installationId,
  { busyCount = 0, allAgents = [] } = {},
) {
  const agent = normalizeAgent(input);
  if (
    busyCount ||
    agent.accessJob ||
    agent.connectionState === "unknown" ||
    installationId === agent.selectedInstallationId
  )
    return input;
  const target = removableInstallations(agent, allAgents).find(
    (item) => item.id === installationId,
  );
  if (!target) return input;
  // Cleaning an unused version does not disconnect the current program or revoke access.
  return {
    ...input,
    installations: agent.installations.filter(
      (item) => item.id !== installationId,
    ),
  };
}

export function removeAgentAccess(
  input,
  { busyCount = 0, allAgents = [], uninstallIds = [] } = {},
) {
  const agent = normalizeAgent(input);
  if (busyCount || agent.accessJob || agent.connectionState === "unknown")
    return input;
  const allowed = new Set(
    removableInstallations(agent, allAgents).map((item) => item.id),
  );
  // Reject the whole request if an external or referenced installation was selected.
  if (uninstallIds.some((id) => !allowed.has(id))) return input;
  const idle = agent.connected ? programAction(agent, "disconnect") : agent;
  const removed = programAction(idle, "remove");
  return {
    ...removed,
    installations: removed.installations.filter(
      (item) => !uninstallIds.includes(item.id),
    ),
    installed: removed.installations.some(
      (item) => !uninstallIds.includes(item.id),
    ),
    sourceId: null,
    serviceId: null,
    serviceSnapshot: undefined,
    setupDraft: undefined,
    setupEvidence: undefined,
    onboarding: null,
    accessMode: "existing",
    source: "沿用已有设置",
  };
}

export function authenticationTypeLabel(method = {}) {
  if (method.type === "env_var" || method.type === "api-key") return "API 密钥";
  if (method.type === "terminal" || method.kind === "terminal")
    return "终端登录";
  if (method.type === "agent" || method.kind === "browser") return "账号授权";
  return "类型未提供";
}

export function agentAccountIdentity(agent, folder) {
  const auth =
    folder === undefined ||
    authenticationFolder(agent.authentication?.folder) ===
      authenticationFolder(folder)
      ? agent.authentication
      : null;
  // A provider or method label is not the identity of the signed-in person.
  return (
    auth?.identity ||
    auth?.accountEmail ||
    auth?.accountName ||
    agent.accountIdentity ||
    "Agent 未提供身份信息"
  );
}

export function setupSelectionSummary(selection = {}, services = []) {
  const service = services.find(
    (item) => item.id === (selection.serviceId || selection.sourceId),
  );
  return {
    source:
      (selection.access || selection.accessMode) === "api"
        ? service?.name || "尚未选择 API 服务"
        : "沿用已有设置",
    model: selection.model || "由 Agent 配置决定",
    effort: selection.effort || "未提供可选等级",
  };
}

export function setupSelectionChanged(before = {}, after = {}) {
  return ["access", "serviceId", "model", "effort", "serviceSnapshot"].some(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}
