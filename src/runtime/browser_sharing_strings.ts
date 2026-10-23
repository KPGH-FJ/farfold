export const BROWSER_SHARING_STRINGS = {
  permission: "读取权限",
  awaiting: "等待你确认读取",
  requestTitle: "需要读取这张网页",
  requestScope:
    "允许此对话的 Agent 读取本页的标题、地址和文字，以继续刚才的请求？不会点击或填写；换页后失效。",
  manualScope:
    "允许此对话的 Agent 读取本页的标题、地址和文字。不会点击或填写；换页后失效。",
  clickTitle: "需要点击网页位置",
  inputTitle: "需要填写网页内容",
  screenshotTitle: "需要截取当前网页",
  operationScope:
    "仅允许这一次操作。请检查页面和具体内容；换页或页面变化后需重新观察。取消或停止共享不能撤销已经交付的网站操作。",
  screenshotScope:
    "仅允许这一次观察：向此对话的 Agent 提供本页的标题、地址、可见文字和可操作位置，以及当前可见区域的截图。不会点击或填写，也不会允许后续读取；截图无法安全提供时，本次请求会停止，不改为只返回文字。",
  operationAllow: "允许本次操作",
  operationDeny: "取消本次操作",
  retained: "停止共享不会删除已提供给 Agent 的内容。",
  allowAndContinue: "允许读取并继续",
  allow: "允许读取",
  allowing: "正在确认…",
  deny: "取消本次读取",
  denying: "正在取消…",
  cancel: "取消",
  viewRequest: "返回对话确认",
  viewPage: "查看网页",
  shared: "已允许读取本页",
  reading: "正在完成本次网页观察",
  unshared: "尚未允许读取",
  preparing: "正在接通网页工具…",
  unavailable: "此对话尚未接通网页工具。你仍可手动浏览网页。",
  disconnected: "网页工具已断开。你仍可手动浏览网页。",
  checking: "正在确认读取权限…",
  noSession: "开始对话后可检查网页工具。你仍可手动浏览网页。",
  inactive: "返回对话后可检查网页工具。",
  connectionLost: "对话已断开，恢复连接后可重新检查网页工具。",
  sourceNotReviewed: "此程序的网页工具接入尚未核实。你仍可手动浏览网页。",
  unsafeLogging: "需先调整程序日志设置，再连接网页工具。你仍可手动浏览网页。",
  launchUnconfirmed: "尚未确认此连接的网页工具启动条件。你仍可手动浏览网页。",
  preparationFailed: "网页工具准备未完成。你仍可手动浏览网页。",
  notEnabledForConversation: "此对话没有启用网页工具。你仍可手动浏览网页。",
  inlineMcpConflict:
    "当前工具设置与网页工具接入冲突。原设置已保留，你仍可手动浏览网页。",
  noPage: "打开网页后可允许 Agent 读取。",
  confirmInChat: "请在对话中确认本次读取。",
  stop: "停止共享",
  stopping: "正在停止共享…",
  stopFailed: "停止尚未确认，请重试。",
  retryStop: "重试停止",
  statusFailed: "未能确认读取权限，请重新检查。",
  allowFailed: "未能确认读取许可，请重新检查后再试。",
  responseFailed: "未能确认本次操作，请重新检查读取请求。",
  refresh: "重新检查",
  allowed: "已允许读取本页。",
  denied: "已取消本次网页读取。",
  stopped: "已停止共享。",
} as const;

/** Reasons are supplied by the backend's actual launch/session boundary. */
export function browserSharingUnavailableReason(
  reason: string | null | undefined,
): string {
  const S = BROWSER_SHARING_STRINGS;
  switch (reason) {
    case "tool_disconnected":
      return S.disconnected;
    case "source_not_reviewed":
      return S.sourceNotReviewed;
    case "unsafe_logging":
      return S.unsafeLogging;
    case "launch_unconfirmed":
      return S.launchUnconfirmed;
    case "preparation_failed":
      return S.preparationFailed;
    case "not_enabled_for_conversation":
      return S.notEnabledForConversation;
    case "inline_mcp_conflict":
      return S.inlineMcpConflict;
    default:
      return S.unavailable;
  }
}
