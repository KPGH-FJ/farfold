// Prototype-only, capability-driven permission selection. No Agent calls.
export function permissionOptions(capability) {
  if (!capability || !Array.isArray(capability.options)) return [];
  const seen = new Set();
  return capability.options.filter((option) => {
    if (
      !option ||
      typeof option.value !== "string" ||
      !option.value ||
      typeof option.label !== "string" ||
      !option.label.trim() ||
      seen.has(option.value)
    )
      return false;
    seen.add(option.value);
    return true;
  });
}

export function permissionOption(capability, value) {
  return permissionOptions(capability).find((option) => option.value === value);
}

const hasSubmittedMessages = (messages) =>
  Array.isArray(messages) ? messages.length > 0 : Boolean(messages);

export function permissionChangeState(task = {}, context = {}) {
  let reason = "";
  if (task.readOnly) reason = "这条对话仅可查看";
  else if (
    context.pending ||
    task.pending ||
    task.permissionPending ||
    task.permissionChange?.phase === "pending"
  )
    reason = "正在确认更改，请稍候";
  else if (task.permissionChange?.phase === "unknown")
    reason = "权限更改结果未确认，请重新确认本次权限";
  else if (
    task.admissionUnknown ||
    task.terminalUnknown ||
    task.terminalState === "unknown" ||
    ["unknown", "recovery"].includes(task.status) ||
    task.stopPhase === "unknown"
  )
    reason = "请先确认上一项工作的结果";
  else if (
    context.connectionBroken ||
    task.connectionBroken ||
    task.connectionState === "lost"
  )
    reason = "重新连接后可更改权限";
  else if (
    context.identityIssue ||
    task.identityIssue ||
    task.identityIncomplete
  )
    reason = "确认原对话设置后可更改权限";
  else if (
    context.historyIncomplete ||
    task.historyIncomplete ||
    (task.recoveryRead && task.recoveryRead.phase !== "complete")
  )
    reason = "对话恢复完成后可更改权限";
  else if (["approval", "question"].includes(task.status))
    reason = "请先处理当前的确认请求";
  else if (
    ["running", "submitting", "stopping"].includes(task.status) ||
    task.stopping ||
    ["waiting", "pending"].includes(task.stopPhase) ||
    hasSubmittedMessages(task.pendingMessages) ||
    hasSubmittedMessages(context.pendingMessages)
  )
    reason = "当前工作结束后可更改权限";
  return { disabled: Boolean(reason), reason };
}
