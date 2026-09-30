import type { SavedFileFeedback } from "./drafts";

export const FEEDBACK_STRINGS = {
  saved: (count: number) => `未发送的文件意见（${count}）`,
  previous: "其他内容版本的意见",
  retained:
    "意见仍对应当时查看的内容。可加入输入框，也可以复制；不会自动发送。",
  version: (index: number) => `保留的意见 ${index + 1}`,
  add: "加入输入框",
  copy: "复制意见",
  copied: "意见已复制。",
  copyFailed: "复制未完成，请重试。",
  added: "意见已加入这条对话的输入框，尚未发送。",
} as const;

export function fileFeedbackText(entry: SavedFileFeedback): string {
  const side = entry.selection?.side === "before" ? "修改前" : "修改后";
  const lines = entry.selection
    ? `${entry.selection.line}${entry.selection.endLine && entry.selection.endLine !== entry.selection.line ? `–${entry.selection.endLine}` : ""}`
    : "";
  const location = entry.selection
    ? entry.scope === "fragment"
      ? `${side}片段第 ${lines} 行`
      : entry.scope === "file"
        ? `${side}第 ${lines} 行`
        : `当时标记的第 ${lines} 行，位置未重新核对`
    : entry.lineInput?.text.trim()
      ? `${entry.lineInput.side === "before" ? "修改前" : "修改后"}${entry.scope === "fragment" ? "片段" : ""}行位置“${entry.lineInput.text.trim()}”（用户填写，尚未核对）`
      : "";
  return `关于 ${entry.path}（当时查看的内容${location ? `，${location}` : ""}）：\n${entry.text.trim()}`;
}
