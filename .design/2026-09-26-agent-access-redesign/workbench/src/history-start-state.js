import {
  usesApi,
  selectedService,
  serviceSourceIdentity,
  serviceChoiceIssue,
} from "./service-access.js";
import { hasDraftContent } from "./workbench-state.js";
import { currentModelOptions } from "./model-read-state.js";
export function historyStartCandidate(
  task,
  message,
  folder = task.folder || "",
) {
  const choice = Object.fromEntries(
    [
      "agent",
      "agentId",
      "model",
      "effort",
      "source",
      "serviceId",
      "serviceSnapshot",
      "accessMode",
      "configValues",
      "originalModelKnown",
    ].map((key) => [key, structuredClone(task[key])]),
  );
  return {
    text: message?.text || "",
    files: structuredClone(message?.attachments || []),
    folder,
    choice,
  };
}
export function historySourceIssue(choice, agents, services, folder = "") {
  const agent = agents.find((item) =>
    choice.agentId ? item.id === choice.agentId : item.name === choice.agent,
  );
  if (!agent || agent.removed)
    return "原 Agent 尚未准备好，请在新草稿中重新选择。";
  if (!choice.model || choice.originalModelKnown === false)
    return "原模型信息未提供，请重新选择模型。";
  if (choice.accessMode === "unknown")
    return "原服务来源尚未确认，请重新选择来源与模型。";
  if (usesApi(choice) && !choice.serviceSnapshot)
    return "原服务身份信息缺失，不能直接沿用，请重新选择来源。";
  if (!usesApi(choice)) {
    const models = currentModelOptions(agent, {
      access: "existing",
      folder,
      serviceId: "",
    });
    if (!models.length)
      return "当前未提供可核对的模型列表，请先检查 Agent 设置再选择模型。";
    if (!models.includes(choice.model))
      return "原模型不在当前可选列表中，请重新选择模型。";
  }
  return serviceChoiceIssue(choice, agent, services) || "";
}
export function suspendedDraft(draft) {
  const copy = structuredClone(draft);
  if (copy?.choice?.configurationChange?.phase === "pending")
    copy.choice.configurationChange.phase = "unknown";
  return copy;
}
export function preserveDraft(current, next, saved, id, restoredId = null) {
  const remaining = saved.filter((item) => item.id !== restoredId);
  if (hasDraftContent(current.text, current.files))
    remaining.push({
      id,
      draft: suspendedDraft(current),
      title:
        current.text.trim().slice(0, 40) || `${current.files.length} 个附件`,
    });
  return { draft: suspendedDraft(next), savedDrafts: remaining };
}
export function currentSourceSummary(choice, services) {
  const service = selectedService(choice, services);
  return {
    service,
    changed:
      usesApi(choice) &&
      serviceSourceIdentity(service) !==
        serviceSourceIdentity(choice.serviceSnapshot),
  };
}
