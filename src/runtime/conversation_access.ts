export interface ZeroSendReceipt {
  accountVerified: true;
  provider: string;
  fileAccess: "read-only";
  toolNetwork: false;
  approval: "on-request";
  model: string;
  effort: string;
}

export interface ZeroSendAccess {
  kind: "zero-send";
  receipt?: ZeroSendReceipt;
}

export const ZERO_SEND_STRINGS = {
  open: "打开对话",
  opening: "正在打开对话…",
  openFailed: "未能确认新对话，可以重试。",
  notReady: "请先确认已保存的模型与思考强度。",
  sendingUnavailable: "这条对话目前无法发送消息，草稿会保留。",
  receiptPending: "这条对话的权限尚未确认。",
  receipt: "已核对本机账号。文件只读，工具网络关闭，操作需经你批准。",
  selection: (provider: string, model: string, effort: string) =>
    `${provider} · ${model} · ${effort}`,
};

const publicValue = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/.test(value);

export function readConversationAccess(
  value: unknown,
): ZeroSendAccess | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) return;
  if (value.kind !== "zero-send") return;
  const access: ZeroSendAccess = { kind: "zero-send" };
  const receipt = (value as { receipt?: Partial<ZeroSendReceipt> }).receipt;
  if (
    receipt?.accountVerified === true &&
    receipt.fileAccess === "read-only" &&
    receipt.toolNetwork === false &&
    receipt.approval === "on-request" &&
    publicValue(receipt.provider) &&
    publicValue(receipt.model) &&
    publicValue(receipt.effort)
  ) {
    access.receipt = {
      accountVerified: true,
      provider: receipt.provider,
      fileAccess: "read-only",
      toolNetwork: false,
      approval: "on-request",
      model: receipt.model,
      effort: receipt.effort,
    };
  }
  return access;
}
