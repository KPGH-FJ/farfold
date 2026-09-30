export const CREDENTIAL_IMPACT_STRINGS = {
  loading: "正在读取此配置影响的对话…",
  failed: "无法读取影响范围。请重试后再删除；现有配置保持不变。",
  heading: (count: number) => `${count} 段对话使用此来源`,
  empty: "已读取的对话中，没有记录使用此来源的对话。",
  hint: "这些对话的历史保留，后续发送需要原服务配置。进行中的任务不会立即停止。",
  unknown: (count: number) =>
    `另有 ${count} 段旧对话未记录可核对的来源，无法确认是否受影响。`,
  archived: "已归档",
  untitled: "未命名对话",
  retry: "重新读取影响范围",
} as const;
