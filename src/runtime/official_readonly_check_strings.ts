export const OFFICIAL_READONLY_CHECK_STRINGS = {
  title: "检查实际权限",
  savedTitle: "检查已保存的模型",
  savedModel: "已保存的模型",
  savedReasoning: "已保存的思考强度",
  back: "返回准备流程",
  start: "检查所选设置",
  cancel: "取消检查",
  checking: "正在检查所选模型与实际权限…",
  cancelling: "正在结束检查…",
  cancelled: "本次检查已结束。",
  cancelFailed: "暂未确认检查已结束，可以再试一次。",
  hint: "用所选模型打开临时只读对话，无需发送消息。结果只适用于这条临时对话。",
  checked: "临时对话的文件权限为只读，工具网络已关闭。",
  account: "已读取本机登录",
  accountUnknown: "未读到本机登录",
  workspace: "已读取账号工作区",
  workspaceUnknown: "未读到账号工作区",
  provider: "模型服务",
  unavailable: "当前程序无法检查实际权限，请重新检查程序。",
  selectionChanged: "当前选择已变化，请按新的设置检查。",
  busy: "已有一项检查正在进行，请稍后再试。",
  timeout: "检查用时较长，未拿到结果，可以重试。",
  outsideScope: "临时对话未确认所选模型和实际权限，请重新检查。",
  failed: "本次检查未完成，请稍后重试。",
};

export function officialReadOnlyCheckError(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  const message = OFFICIAL_READONLY_CHECK_STRINGS;
  switch (code) {
    case "unavailable":
      return message.unavailable;
    case "selectionChanged":
      return message.selectionChanged;
    case "busy":
      return message.busy;
    case "timedOut":
      return message.timeout;
    case "invalidOutput":
    case "unconfirmed":
      return message.outsideScope;
    case "cancelled":
      return message.cancelled;
    default:
      return message.failed;
  }
}
