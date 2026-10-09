/** Selected readable categories only: neither a complete archive nor a recovery file. */
const included =
  "用户与助手消息、附件说明、工具摘要与报告位置、计划、批准或拒绝记录，以及停止、失败或结果未确认的提示。";
export const EXPORT_STRINGS = {
  scope: `导出时当前已载入的${included}`,
  excludedScope:
    "这不是完整对话归档：不包含思考内容、一般通知、上下文整理记录、原始事件、折叠的工具详情、未载入的历史、草稿与待发内容。",
  attachmentsScope:
    "附件文件未打包，只保留名称、类型与来源；来源由对话提供，未核验文件，也未下载网页内容。",
  privacyScope:
    "地址中的认证与附加参数未导出。导出前请自行检查正文与来源中的私人信息。",
  snapshot: "此消息仍在接收，以下为导出时已收到的内容。",
  noSource: "未提供来源位置",
  omittedSource: "来源地址未导出",
  attachment: "附件",
  location: "报告位置",
  diff: "修改位置",
  link: "链接",
  type: "类型",
  line: (line: number) => `报告行号：${line}`,
  lineScope: "报告行号保留对话提供的原值，起始基准未确认。",
  status: {
    pending: "等待中",
    in_progress: "进行中",
    completed: "已完成",
    failed: "失败",
  },
  unknown: "状态未确认",
  unconfirmed: "保存未确认",
  failed: "未确认本次保存结果，请检查所选位置后再决定是否重试。",
  cancelled: "已取消本次保存",
  dialogSummary: "已载入内容的 Markdown 快照，附件未打包。",
  details: "范围与隐私",
  dialogScope: `保存打开此窗口时已载入的${included}这是 Markdown 快照，后续消息不会补入；附件文件未打包。`,
} as const;
