import { setupTestFingerprint } from "./agent-catalog.js";
import {
  compatibleServices,
  agentServiceFormats,
  serviceUsable,
  serviceAuthenticationIssue,
  changedServiceSource,
} from "./service-access.js";

import {
  authenticationFolder,
  authenticationRetryAllowed,
  accountRequiredForSelection,
} from "./authentication-state.js";
import { entitlementCheckIssue } from "./selection-entitlement.js";
import { currentModelOptions } from "./model-read-state.js";
export {
  authenticationFolder,
  authenticationRequiredFor,
  markAuthenticationForRetry,
} from "./authentication-state.js";

export function normalizeAgent(agent) {
  const installed = !!agent.installed;
  const installations =
    agent.installations ||
    (installed || agent.discovered
      ? [
          {
            id: `${agent.id}-local`,
            path: `/Applications/Agent Programs/${agent.id}`,
            version: agent.version || "未读取",
            componentVersion: agent.componentVersion || "",
            managed: false,
            discovered: true,
          },
        ]
      : []);
  const selectedInstallationId =
    agent.selectedInstallationId !== undefined
      ? agent.selectedInstallationId
      : installed
        ? installations[0]?.id
        : null;
  return {
    ...agent,
    onboardingComplete:
      agent.onboardingComplete ?? agent.setupComplete === true,
    installations,
    selectedInstallationId,
    registered: agent.registered ?? (installed && !agent.removed),
    added: (agent.added ?? installed) && !agent.removed,
    connectionState:
      agent.connectionState || (agent.connected ? "connected" : "idle"),
    programRevision: agent.programRevision || 0,
    connectionRevision: agent.connectionRevision || 0,
    dependenciesMissing: !!agent.dependenciesMissing,
    authRequired: !!agent.authRequired,
    authMethods: agent.authMethods || [],
    configOptions: agent.configOptions || [],
    efforts: agent.efforts || [],
  };
}
export const busyAgentTasks = (agent, tasks = []) =>
  tasks.filter(
    (task) =>
      (task.agentId ? task.agentId === agent.id : task.agent === agent.name) &&
      [
        "running",
        "submitting",
        "approval",
        "question",
        "stopping",
        "stopUnconfirmed",
        "unknown",
      ].includes(task.status),
  );
export function agentProgramReady(input) {
  if (!input) return false;
  const agent = normalizeAgent(input);
  return !!(
    agent.installed &&
    agent.registered &&
    agent.connected &&
    agent.connectionState === "connected" &&
    !agent.dependenciesMissing &&
    !agent.removed
  );
}
export const agentCanAttempt = (agent) =>
  agentProgramReady(agent) &&
  !["install", "select", "dependency", "connect", "auth"].includes(
    agent.accessJob?.type,
  );
// Program readiness allows repair and existing-history operations. New work also
// requires the user's first preparation to have been explicitly confirmed.
export const agentNeedsInitialPreparation = (agent) =>
  !!agent && !(agent.onboardingComplete ?? agent.setupComplete === true);
export const agentCanStartConversation = (agent) =>
  agentCanAttempt(agent) && !agentNeedsInitialPreparation(agent);
export const setupFingerprint = setupTestFingerprint;
export function initialSetupDraft(agent, services = []) {
  const previous = agent.setupDraft || {};
  const access =
    previous.access === "api" ||
    (!previous.access && agent.accessMode === "api")
      ? "api"
      : "existing";
  return {
    access,
    serviceId: agent.sourceId || agent.serviceId || "",
    serviceSnapshot: agent.serviceSnapshot
      ? structuredClone(agent.serviceSnapshot)
      : undefined,
    model: agent.model ?? agent.models?.[0] ?? "",
    effort: agent.effort ?? agent.efforts?.[0] ?? "",
    test: "idle",
    testFingerprint: null,
    ...previous,
    folder: authenticationFolder(previous.folder ?? agent.preparationFolder),
    access,
  };
}
export function serviceAuthIssueFor(agent, service) {
  return (
    service &&
    (agent.serviceAuthIssues || []).find(
      (issue) =>
        issue.serviceId === service.id &&
        issue.secretRevision === (service.secretRevision || 0),
    )
  );
}
export function setupChoiceIssue(agent, draft, services) {
  if (!agent.installed || agent.removed || !agent.registered)
    return "先添加并准备程序。";
  if (agent.dependenciesMissing) return "还缺少运行所需的程序。";
  if (!agent.connected || agent.connectionState !== "connected")
    return "先确认程序能够连接。";
  if (draft.access === "api") {
    const service = services.find((item) => item.id === draft.serviceId);
    if (changedServiceSource(draft, service))
      return "服务地址或接口已改变，请明确确认新来源后继续。";
    if (!compatibleServices(agent, services).includes(service))
      return "选择兼容且完整的已保存服务。";
    if (!service.models.includes(draft.model)) return "选择这个服务中的模型。";
    const authenticationIssue = serviceAuthenticationIssue(agent, service);
    if (authenticationIssue) return authenticationIssue;
  } else {
    const models = currentModelOptions(agent, draft);
    if (models.length && !models.includes(draft.model))
      return "重新确认 Agent 提供的模型。";
  }
  if (
    accountRequiredForSelection(agent, draft) &&
    !authenticationRetryAllowed(agent, draft)
  )
    return "请先完成 Agent 账号认证，再检查当前设置。";
  return entitlementCheckIssue(
    agent,
    draft,
    draft.access === "api"
      ? services.find((item) => item.id === draft.serviceId)
      : undefined,
  );
}
export function setupCompletionIssue(agent, draft, services) {
  // Finishing preparation returns to a draft. It does not assert a successful
  // request; repaired authentication/entitlement can be checked by that send.
  return setupChoiceIssue(agent, draft, services);
}
export function preparedAgent(agent, draft, services) {
  const service =
    draft.access === "api"
      ? services.find((item) => item.id === draft.serviceId)
      : null;
  return {
    ...agent,
    added: true,
    accessMode: draft.access,
    source: service?.name || "沿用已有设置",
    sourceId: service?.id || null,
    serviceId: service?.id || null,
    serviceSnapshot: service
      ? {
          id: service.id,
          endpoint: service.endpoint,
          format: service.format,
          revision: service.revision,
          secretRevision: service.secretRevision,
        }
      : undefined,
    model: draft.model,
    effort: draft.effort,
    preparationFolder: authenticationFolder(draft.folder),
    setupDraft: { ...draft, folder: authenticationFolder(draft.folder) },
    setupEvidence: { ...draft, folder: authenticationFolder(draft.folder) },
    setupComplete: true,
    onboardingComplete: true,
    preparationIssue: null,
    demoReady: true,
  };
}
export function reconcileAgentServices(agents, services) {
  let changed = false;
  const result = agents.map((agent) => {
    if (agent.accessMode !== "api" || !agent.setupComplete) return agent;
    const draft = {
      access: "api",
      serviceId: agent.sourceId || agent.serviceId,
      model: agent.model,
      effort: agent.effort || "",
      folder: authenticationFolder(agent.preparationFolder),
    };
    const service = services.find((item) => item.id === draft.serviceId);
    if (
      serviceUsable(service) &&
      agentServiceFormats(agent).includes(service.format) &&
      service.models.includes(draft.model) &&
      agent.serviceSnapshot?.endpoint === service.endpoint &&
      agent.serviceSnapshot?.format === service.format &&
      (agent.serviceSnapshot?.revision || 0) === (service.revision || 0) &&
      (agent.serviceSnapshot?.secretRevision || 0) ===
        (service.secretRevision || 0)
    )
      return agent;
    changed = true;
    return {
      ...agent,
      setupComplete: false,
      demoReady: false,
      preparationIssue: "服务已变化，下次使用前请重新确认；进行中的工作继续。",
      setupDraft: {
        ...initialSetupDraft(agent, services),
        test: "idle",
        testFingerprint: null,
      },
    };
  });
  return changed ? result : agents;
}
export const serviceConversations = (service, tasks = []) =>
  tasks.filter((task) =>
    task.serviceId
      ? task.serviceId === service.id
      : task.accessMode !== "existing" && task.source === service.name,
  );
