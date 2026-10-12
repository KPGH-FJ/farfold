import { DOCUMENT_STRINGS } from "./document_strings";

export const DOCUMENT_INPUT_STRINGS = {
  title: "加入文档文字",
  read: "加入文字",
  reread: "重新读取文字",
  view: "查看已加入文字",
  approved: "已加入文字",
  needsSource: "文字来源待核对",
  loading: "正在读取文档文字…",
  checking: "正在核对文件版本…",
  confirm: "加入这些文字",
  confirmPartial: "只加入已读取文字",
  partialConsent: "我已查看缺失说明，只加入本次已读取的文字。",
  cancel: "取消",
  cancelled: "已取消本次读取。",
  scope:
    "加入保存的正文、表格和已读取的附注文字。图片像素、批注和未读取内容不加入；字段只使用保存的结果。",
  scopePartial: "部分内容未读取，下面的文字仅代表已读取范围。",
  draftOnly: "确认只更新未发送内容；发送仍需单独操作。",
  allText: "本次拟加入的全部文字",
  previousText: "保留的原文字",
  savedText: "已确认的文字",
  sourceVersion: "保留所选文件版本；发送前再次核对文件。",
  restored: "退出后恢复的文字需要重新核对来源，不会自动发送。",
  omissions: "读取范围与缺失说明",
  count: (bytes: number, images: number) =>
    `文字表示 ${bytes.toLocaleString()} 字节；${images} 处图片未加入。`,
  changed: "输入或目标已变化，请重新选择此附件。",
  fileChanged: "文件已变化，请重新读取并确认文字后再发送。",
  saved: "文字已加入并保存，可继续编辑。",
  saveFailed: "文字已加入，但未发送内容尚未保存。请重试保存后再发送或关闭。",
  capabilityUnsupported:
    "此对话目前不支持接收附件文字。文字已保留，请检查所选 Agent。",
  capabilityUnknown:
    "尚未确认此对话能否接收附件文字。文字已保留，请核对连接后再发送。",
  recoveryRequired: "文字来源尚未核对，请重新读取并确认此附件。",
  noText: "没有读到可加入的文字。图片和文档标记不算正文。",
  textLimit: "读取的文字超过 256 KiB，暂不能加入；没有截断内容。",
  sourceUnknown: "文字来源尚未核对，请重新读取并确认此附件。",
  capabilityUnavailable: "此对话暂不能接收附件文字，输入内容已保留。",
  failed: "未能加入此文档文字，请检查文件后重新读取。",
} as const;

/** Only app-authored short failures reach the shared document input surface. */
export function documentInputFailure(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (typeof code === "string") {
    if (
      [
        "noText",
        "textLimit",
        "sourceUnknown",
        "capabilityUnavailable",
        "capabilityUnsupported",
        "capabilityUnknown",
        "recoveryRequired",
      ].includes(code)
    )
      return DOCUMENT_INPUT_STRINGS[
        code as
          | "noText"
          | "textLimit"
          | "sourceUnknown"
          | "capabilityUnavailable"
          | "capabilityUnsupported"
          | "capabilityUnknown"
          | "recoveryRequired"
      ];
    if (code === "cancelled") return DOCUMENT_INPUT_STRINGS.cancelled;
    if (code === "changed") return DOCUMENT_INPUT_STRINGS.fileChanged;
    if (
      [
        "invalid",
        "unsupported",
        "limit",
        "encrypted",
        "changed",
        "unreadable",
        "readPending",
        "readBusy",
        "timeout",
        "busy",
      ].includes(code)
    )
      return DOCUMENT_STRINGS[code as keyof typeof DOCUMENT_STRINGS] as string;
  }
  return DOCUMENT_INPUT_STRINGS.failed;
}
