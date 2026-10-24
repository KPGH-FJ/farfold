export const PROMPT_ADMISSION = {
  waiting: "正在等待发送…",
  preparing: "正在准备发送…",
  cancel: "取消等待",
  cancelling: "正在取消等待…",
  unconfirmed: "尚未确认取消结果，消息不会自动重发。",
  full: "等待发送的消息已达上限，请稍后明确重试。",
  payload: "待发内容超过当前总量限制，请保留内容并稍后重试。",
  cancelled: "已取消等待，原内容已保留。",
  timeout: "等待发送已结束，原内容已保留。请检查正在进行的任务，再明确重试。",
} as const;
