import {
  additionalOptions,
  validAdditionalValues,
  configurationValuesEqual,
} from "./additional-configuration.js";
// Prototype-only configuration receipts. No Agent or settings calls.
export function configurationModels(capability, task = {}) {
  const models = (capability?.models || [])
    .map((model) =>
      typeof model === "string" ? { id: model, label: model } : model,
    )
    .filter((model) => model?.id && model?.label);
  return models.length
    ? models
    : [{ id: task.model || "", label: task.model || "当前模型未提供" }];
}
export function configurationScope(task = {}) {
  return JSON.stringify([
    task.id,
    task.agentId || task.agent,
    task.accessMode || task.access,
    task.serviceId || task.sourceId,
    task.source,
    task.folder,
    task.serviceSnapshot?.endpoint,
    task.serviceSnapshot?.format,
    task.serviceSnapshot?.revision,
    task.serviceSnapshot?.secretRevision,
  ]);
}
export function configurationChoice(task = {}) {
  return {
    model: task.model,
    effort: task.effort,
    configValues: structuredClone(task.configValues || {}),
  };
}
export function configurationGate(task = {}) {
  if (task.readOnly) return "这条对话仅可查看";
  if (task.configurationChange?.phase === "pending")
    return "正在确认并保存设置";
  if (task.configurationChange?.phase === "unknown")
    return "设置结果未确认，请先核对";
  if (
    task.identityIncomplete ||
    task.connectionState === "lost" ||
    task.permissionReconfirmRequired ||
    task.permissionChange ||
    task.admissionUnknown ||
    task.stopPhase ||
    (task.recoveryRead && task.recoveryRead.phase !== "complete")
  )
    return "请先处理当前待确认事项";
  if (!["draft", "done", "stopped", "failed"].includes(task.status))
    return "当前工作结束后可更改设置";
  return "";
}
export function validConfiguration(task, capability, next) {
  const models = configurationModels(capability, task);
  const selected = models.find((model) => model.id === (next.model || ""));
  if (!selected) return false;
  if (next.model !== task.model && !capability?.supportsModelChange)
    return false;
  if (next.effort !== task.effort && !capability?.supportsEffortChange)
    return false;
  const efforts = selected.efforts || capability?.efforts || [];
  return (
    (next.effort === task.effort || efforts.includes(next.effort)) &&
    validAdditionalValues(
      additionalOptions(capability, task),
      task.configValues,
      next.configValues ?? task.configValues,
    )
  );
}
export function startConfigurationChange(task, capability, next, id) {
  if (configurationGate(task) || !validConfiguration(task, capability, next))
    return null;
  return {
    configurationChange: {
      id,
      phase: "pending",
      scope: configurationScope(task),
      previous: configurationChoice(task),
      next: {
        ...next,
        configValues: structuredClone(
          next.configValues ?? task.configValues ?? {},
        ),
      },
      capability,
      reviewConfigurationOptions: task.reviewConfigurationOptions,
    },
    configurationNotice: "",
    queuePaused: Boolean(task.queue?.length) || task.queuePaused,
  };
}
function scopeMatches(task, change) {
  return (
    change.scope === configurationScope(task) &&
    task.model === change.previous.model &&
    task.effort === change.previous.effort &&
    configurationValuesEqual(task.configValues, change.previous.configValues) &&
    Boolean(task.reviewConfigurationOptions) ===
      Boolean(change.reviewConfigurationOptions)
  );
}
export function finishConfigurationChange(task, id, outcome) {
  const change = task.configurationChange;
  if (
    !change ||
    change.id !== id ||
    !["pending", "unknown"].includes(change.phase) ||
    !["success", "failed", "unknown"].includes(outcome)
  )
    return null;
  if (outcome === "unknown" || !scopeMatches(task, change))
    return {
      configurationChange: { ...change, phase: "unknown" },
      queuePaused: true,
    };
  if (outcome === "failed")
    return {
      configurationChange: null,
      configurationNotice:
        "更改未保存，继续使用之前已确认的设置。待发消息由你继续发送。",
    };
  const base = { ...task, configurationChange: null };
  if (
    configurationGate(base) ||
    !validConfiguration(base, change.capability, change.next)
  )
    return {
      configurationChange: { ...change, phase: "unknown" },
      queuePaused: true,
    };
  return {
    ...change.next,
    configurationChange: null,
    confirmConfiguration: { id },
    configurationNotice:
      "设置已确认并保存，将用于下一条消息。已有消息保持原样。",
    queuePaused: Boolean(task.queue?.length) || task.queuePaused,
  };
}
export function configurationReceiptMatches(task, patch) {
  const change = task.configurationChange;
  return Boolean(
    change &&
    scopeMatches(task, change) &&
    patch.confirmConfiguration?.id === change.id &&
    patch.model === change.next.model &&
    patch.effort === change.next.effort &&
    configurationValuesEqual(patch.configValues, change.next.configValues) &&
    !configurationGate({ ...task, configurationChange: null }) &&
    validConfiguration(task, change.capability, change.next),
  );
}
