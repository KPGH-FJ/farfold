/**
 * W3 对话面：错误呈现统一文案。PRODUCT.md §6 分层 —— 错误面只给
 * 「结论 + 下一步」，原始错误文本与代码收进可展开的技术详情。
 */
export const ERROR_STRINGS = {
  /** Collapsed disclosure label for raw error text / codes. */
  technicalDetails: "技术详情",
  agentInitializeFailed: "连接检查未完成，请检查程序或启动设置后重试",
  agentInitializeTimeout: "等待连接检查超时，请稍后重试",
  agentConnectionEnded: "连接在检查完成前结束，请检查程序后重试",
  agentStartFailed: "程序未能启动，请检查程序文件和资料文件夹后重试",
} as const;
