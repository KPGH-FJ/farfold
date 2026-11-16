/**
 * W3 对话面：错误呈现统一文案。PRODUCT.md §6 分层 —— 错误面只给
 * 「结论 + 下一步」，原始错误文本与代码收进可展开的技术详情。
 */
export const ERROR_STRINGS = {
  /** Collapsed disclosure label for raw error text / codes. */
  technicalDetails: "技术详情",
  agentInitializeFailed: "连接检查未完成，请检查程序或启动设置后重试",
  agentInitializeTimeout:
    "连接检查超时，原因尚未确定。请先查看是否有待处理的登录或文件夹访问提示，再检查程序启动设置",
  agentConnectionEnded: "连接在检查完成前结束，请检查程序后重试",
  agentStartFailed: "程序未能启动，请检查程序文件和资料文件夹后重试",
  agentOpenTimeout:
    "打开对话尚未确认完成，等待已超时。原内容已保留，请先查看是否有待处理的提示。",
  agentOpenClosed:
    "打开对话尚未确认完成，未能取得结果。原内容已保留，请检查连接后重试。",
  agentOpenWaitCancelled: "已取消等待读取。原内容已保留。",
  modelProviderCreditsExhausted:
    "当前模型的提供方额度已用尽。请在 Agent 的设置中查看可用模型。",
  sessionToolChangePending:
    "工具修改结果尚未确认，请先核查工具设置，再重新打开这段对话。原内容已保留。",
  workDirectoryUnavailable:
    "工作文件夹不存在或无法访问，请恢复后重试。原内容已保留。",
} as const;
