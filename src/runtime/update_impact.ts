import {
  hasActiveTools,
  hasPendingRequests,
  type ThreadState,
} from "./session_types";

export const UPDATE_IMPACT = {
  title: "安装影响",
  hint: "安装需要重启。已保存的草稿和意见会保留，待发消息会暂停，不会自动发送。",
  blocked: "请先处理以下工作，再回来安装。",
  finalCheck:
    "安装前还会核对账号、程序操作和保存结果；本页不会提前判定安装成功。",
  open: "查看这条对话",
  untitled: "未命名对话",
  savedDraft: "未发送内容将保存并保留",
  newDraft: "新对话的未发送内容也会保存并保留。",
  queue: "待发消息将保留并暂停",
  saving: "正在保存未发送内容…",
  retrySave: "重试保存",
  noWork: "当前没有已知的对话阻碍。",
  needDecision: "有等待你处理的请求",
  unknown: "上次操作结果尚未确认",
  stopping: "正在等待停止确认",
  running: "仍在执行",
  tools: "仍有步骤未确认结束",
  sending: "正在发送",
  connecting: "正在恢复连接",
  changing: "正在更改设置",
  accounts: "账号操作尚未结束",
  accountUnknown: "账号操作的结果尚未确认",
  openAgents: "返回 Agent 查看",
} as const;

/** Same frontend preflight for the impact list and installation admission. */
export function updateConversationBlocker(thread: ThreadState): string | null {
  if (
    thread.stopUnconfirmed ||
    thread.uncertainPrompt ||
    thread.connectionOutcomeUnknown ||
    thread.permissionState === "unknown"
  )
    return UPDATE_IMPACT.unknown;
  if (hasPendingRequests(thread)) return UPDATE_IMPACT.needDecision;
  if (thread.stopping) return UPDATE_IMPACT.stopping;
  if (thread.submitting) return UPDATE_IMPACT.sending;
  if (thread.reconnecting) return UPDATE_IMPACT.connecting;
  if (thread.configuring) return UPDATE_IMPACT.changing;
  if (thread.running) return UPDATE_IMPACT.running;
  if (hasActiveTools(thread)) return UPDATE_IMPACT.tools;
  return null;
}

export interface UpdateConversationImpact {
  key: string;
  title: string;
  reason: string;
  blocking: boolean;
}
