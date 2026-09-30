import { apiSourceIdentity } from "./api-editor-state.js";

export function usesApi(selection = {}) {
  if (selection.accessMode) return selection.accessMode === "api";
  return Boolean(
    selection.serviceId ||
    (selection.source && selection.source !== "沿用已有设置"),
  );
}
export function serviceAccess(agent) {
  if (agent?.serviceCapabilities)
    return agent.serviceCapabilities.status === "implemented"
      ? "supported"
      : "unavailable";
  if (agent?.serviceConfigurationReady === true) return "supported";
  if (agent?.proposal && agent?.demoReady) return "proposal";
  return "unavailable";
}
export function agentServiceFormats(agent) {
  if (serviceAccess(agent) === "unavailable") return [];
  return agent?.serviceCapabilities?.formats || agent?.apiFormats || [];
}
export const serviceUsable = (service) =>
  !!service &&
  !service.deleting &&
  service.demoKey !== false &&
  !!service.models?.length;
export function compatibleServices(agent, services = []) {
  if (serviceAccess(agent) === "unavailable") return [];
  return services.filter(
    (service) =>
      serviceUsable(service) &&
      agentServiceFormats(agent).includes(service.format),
  );
}
export function selectedService(selection = {}, services = []) {
  if (!usesApi(selection)) return undefined;
  return services.find((service) =>
    selection.serviceId
      ? service.id === selection.serviceId
      : service.name === selection.source,
  );
}
export const serviceSourceIdentity = (service) => apiSourceIdentity(service);
export const serviceSelectionSnapshot = (service) =>
  service
    ? {
        id: service.id,
        name: service.name,
        endpoint: service.endpoint,
        format: service.format,
        revision: service.revision,
        secretRevision: service.secretRevision,
      }
    : undefined;
export function changedServiceSource(selection, service) {
  return Boolean(
    service &&
    selection.serviceSnapshot &&
    serviceSourceIdentity(service) !==
      serviceSourceIdentity(selection.serviceSnapshot),
  );
}
// Each Agent owns its observations. A new key may be tried, but renaming a
// service or changing another configuration must not erase an explicit failure.
export function serviceAuthenticationIssue(agent, service) {
  if (
    service &&
    agent?.serviceAuthIssues?.some(
      (issue) =>
        issue.serviceId === service.id &&
        (issue.secretRevision || 0) === (service.secretRevision || 0),
    )
  )
    return "此 API 服务认证失败，请更新该服务的密钥后重试。当前内容保留。";
  return null;
}
export function serviceChoiceIssue(selection, agent, services) {
  if (!usesApi(selection)) return null;
  if (serviceAccess(agent) === "unavailable")
    return "这个 Agent 尚未接通新增 API 服务，请选择已有设置。你的输入仍在。";
  const service = selectedService(selection, services);
  if (
    !service ||
    service.deleting ||
    !service.models?.includes(selection.model)
  )
    return "这个模型来源已改变，请重新选择。你的输入仍在。";
  if (!agentServiceFormats(agent).includes(service.format))
    return "所选 API 的接口不适用于这个 Agent，请重新选择。你的输入仍在。";
  if (service.demoKey === false)
    return "此服务尚未配置演示密钥，请先补齐。你的输入仍在。";
  if (
    selection.serviceSnapshot &&
    serviceSourceIdentity(service) !==
      serviceSourceIdentity(selection.serviceSnapshot)
  )
    return "所选服务的地址或接口已改变，请重新确认。你的输入仍在。";
  return serviceAuthenticationIssue(agent, service);
}
// Only check before a new send. A mutation does not stop already running work.
export function continuationIssue(task = {}, services = [], agent) {
  if (!usesApi(task)) return null;
  const snapshot = task.serviceSnapshot;
  const id = task.serviceId || snapshot?.id;
  if (!id || !snapshot?.endpoint || !snapshot?.format)
    return "此对话的原服务来源未记录完整，保留历史；请确认原来源或明确新建对话。";
  const service = services.find((item) => item.id === id);
  if (!service || service.deleting)
    return "原 API 配置已删除，历史仍保留。请恢复原配置或明确新建对话。";
  if (serviceSourceIdentity(service) !== serviceSourceIdentity(snapshot))
    return "原服务的地址或接口已改变，不能自动替换此对话的来源。请恢复原配置或新建对话。";
  if (!service.models?.includes(task.model))
    return "此对话的模型已从原服务移除，请恢复该模型或新建对话。";
  if (service.demoKey === false)
    return "原服务缺少可用的演示密钥，请在 API 配置中补齐后重试。";
  return serviceAuthenticationIssue(agent, service);
}
