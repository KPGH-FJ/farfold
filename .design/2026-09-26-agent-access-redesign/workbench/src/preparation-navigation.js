export function setupContextForEntry(entry) {
  if (!entry) return { view: "agents", folder: "" };
  return {
    view: entry.contextView || entry.view,
    active: Object.hasOwn(entry, "contextActive")
      ? entry.contextActive
      : entry.active,
    folder: entry.folder || "",
    agent: entry.agent,
    intent: entry.intent,
    repair: entry.repair,
    panel: entry.panel,
    reason: entry.reason,
    directoryView: entry.directoryView,
  };
}

export function preparationWork(tasks, pendingSend) {
  if (!pendingSend) return tasks;
  return [
    ...tasks,
    {
      ...pendingSend.draft.choice,
      id: pendingSend.id,
      title: "正在发送首条消息",
      status: "submitting",
      canOpen: false,
    },
  ];
}

export function conversationPreparationRequest(task, request = {}) {
  return {
    ...request,
    contextView: "thread",
    contextActive: task.id,
    agent: task.agent,
    folder: task.folder || "",
    choice: structuredClone(task),
    reason: `来自“${task.title}”：${request.reason || "检查此对话的 Agent 设置。"}`,
  };
}
