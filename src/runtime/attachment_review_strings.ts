export const ATTACHMENT_REVIEW = {
  title: "核对恢复的附件",
  hint: "当前输入与待发消息已保留。核对附件后，由你继续发送。",
  open: "核对附件",
  draft: "当前输入",
  queue: (index: number) => `待发消息 ${index + 1}`,
  image: "图片",
  details:
    "所选本地文件会重新检查可读性；图片保留已保存的内容。未勾选的附件会移除。",
  emptyQueue: "仅含附件的待发消息若全部移除，也会移出待发。",
  protected: "这条消息正在发送或发送结果尚未确认，暂时不能修改附件。",
  editing: "这条对话有尚未完成的待发编辑，请先处理编辑内容。",
  later: "稍后处理",
  confirm: "保留所选附件",
  checking: "正在核对…",
  done: "附件已核对，已保留你的选择。",
  changed: "内容已变化，请关闭后重新核对。原内容已保留。",
  unreadable: (name: string) => `无法读取“${name}”，请取消勾选或重新选择附件。`,
} as const;
