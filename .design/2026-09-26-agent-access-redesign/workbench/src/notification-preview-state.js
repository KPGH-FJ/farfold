export const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled: false,
  sound: false,
};

export function notificationPreferences(value = {}) {
  return {
    enabled: value?.enabled === true,
    sound: value?.sound === true,
  };
}

export const NOTIFICATION_PERMISSION_LABELS = {
  "not-requested": "尚未请求",
  granted: "已允许",
  denied: "已拒绝",
  unavailable: "当前不可用",
};

export function notificationAttention(task) {
  if (task?.stopPhase === "unknown") return "停止结果需要确认";
  return (
    {
      approval: "等待你批准",
      question: "等待你回答",
      failed: "工作遇到问题",
      error: "工作遇到问题",
      unknown: "工作结果需要确认",
      recovery: "需要检查恢复条件",
    }[task?.status] || null
  );
}

export function notificationPreviewBlock(preferences, permission) {
  if (!notificationPreferences(preferences).enabled) return "请先开启提醒";
  if (permission === "not-requested") return "请先完成权限演示";
  if (permission === "denied") return "需要在系统设置中允许通知";
  if (permission !== "granted") return "当前无法使用系统通知";
  return null;
}

export function notificationPreviewTargets(tasks, selected = "multiple") {
  const current = tasks.filter((task) => task?.id && !task.archived);
  const ordered = [
    ...current.filter(notificationAttention),
    ...current.filter((task) => !notificationAttention(task)),
  ];
  const selectedTasks =
    selected === "multiple"
      ? ordered.slice(0, 3)
      : current.filter((task) => task.id === selected);
  return selectedTasks.map((task) => ({
    taskId: task.id,
    title: task.title || "未命名对话",
    agent: task.agent || "Agent",
    reason: notificationAttention(task),
  }));
}

export function resolveNotificationTarget(preview, tasks) {
  const task = tasks.find((item) => item.id === preview.taskId);
  if (!task) return { state: "missing", task: null };
  const reason = notificationAttention(task);
  return {
    state: preview.reason && reason !== preview.reason ? "changed" : "current",
    task,
    reason,
  };
}
