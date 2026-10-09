export const COMPACTION = {
  inProgress: "正在整理上下文",
  completed: "上下文已整理",
  failed: "上下文整理失败",
  cancelled: "上下文整理已取消",
  opaque: "上下文整理状态待确认",
  unknown: "上下文整理结果未知",
  summary: "保留的摘要",
  partialSummary: "未完成的摘要",
  noSummary: "未提供可显示的摘要",
  details: "整理详情",
  roundCompleted: "整理已结束",
  roundPending: "整理尚未结束",
  roundFailed: "整理未完成",
  roundUnknown: "整理结果待确认",
} as const;

export function maintenanceLabel(result?: string): string | null {
  switch (result) {
    case "maintenance":
      return COMPACTION.roundCompleted;
    case "maintenance_pending":
      return COMPACTION.roundPending;
    case "maintenance_failed":
      return COMPACTION.roundFailed;
    case "maintenance_unknown":
      return COMPACTION.roundUnknown;
    default:
      return null;
  }
}
