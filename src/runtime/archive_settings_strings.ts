export const ARCHIVE_SETTINGS = {
  custom: "自定义天数…",
  days: "归档等待天数",
  range: "输入 1–365 的整数天数，保存后生效。",
  invalid: "请输入 1–365 的整数天数。",
  save: "保存天数",
  current: (days: number) =>
    days === 0 ? "当前规则：关闭自动归档" : `当前规则：结束后等待 ${days} 天`,
};
