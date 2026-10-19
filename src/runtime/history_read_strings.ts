export const HISTORY_READ = {
  finishing: "正在结束本次读取…",
  releasing: "正在确认…",
  releaseUnconfirmed:
    "尚未确认本次读取已结束，后续读取可能仍需等待。重试只确认接收，不会再次读取对话。",
  releaseMissing:
    "尚未收到读取结束凭据，后续读取可能仍需等待。可正常保存并退出应用后再打开；原对话与设置保留。",
  retryRelease: "重新确认结束",
  preparing: "正在准备读取对话…",
  waiting: "正在等待读取对话…",
  starting: "正在读取对话…",
  cancel: "取消等待",
  cancelling: "正在取消等待…",
  cancelled: "已取消等待读取。",
  unconfirmed: "尚未确认取消结果，请稍后重试。",
} as const;
