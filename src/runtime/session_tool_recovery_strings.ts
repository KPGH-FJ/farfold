export const TOOL_RECOVERY = {
  title: "核查工具修改",
  hint: "先检查这段对话的工具设置，再决定是否重新打开。不会重试添加或撤回，也不会发送消息。",
  inspect: "检查工具设置",
  checking: "正在核查工具设置…",
  confirm: "确认核查结果",
  acceptCurrent: "接纳当前设置",
  currentConfiguration: "当前保存的工具清单",
  currentSettings:
    "以下列出本次读取的全部工具和可核对的连接地址。接纳后可重新打开对话，不代表此前修改成功或工具已经可用。",
  limitedReview:
    "部分设置无法安全、完整地展示，暂时不能接纳。原记录保留，请核对后重新检查。",
  acceptedCurrent:
    "已接纳目前保存的工具设置。此前修改结果仍无法单独确认；请重新打开对话，再检查实际可用工具。原消息、草稿和待发内容保留。",
  emptyConfiguration: "当前保存的工具清单为空。",
  configurationKinds: {
    builtin: "内置工具",
    platform: "平台工具",
    http: "网络工具",
  },
  checkConfirmation: "检查确认结果",
  confirming: "正在确认…",
  resolved: "核查已确认。请重新打开这段对话；原消息、草稿和待发内容保留。",
  unavailable: "当前还有未结束的操作，请稍后再检查。",
  failed: "本次核查未能确认结果，请稍后重新检查。",
  invalidResponse: "未能核实这次核查的完整结果，请重新检查。",
  timeout: "核查尚未返回结果，请保留当前对话并稍后查看。",
  outcomes: {
    none: "未找到这次修改的待核记录。不能据此确认旧操作结果，请重新读取原操作结果。",
    busy: "原操作尚未结束，暂时不能核查。请稍后再检查。",
    closing: "正在安全结束这段对话的旧连接，请稍后再检查。",
    unchanged: "已保存的工具设置与修改前一致。确认后可重新打开对话。",
    applied:
      "已保存的工具设置与这次修改的目标一致。确认后可重新打开对话；实际调用仍需验证。",
    changed:
      "工具设置还存在其他变化，无法据此确认之前的修改结果。请审阅当前设置后再决定。",
  },
} as const;
