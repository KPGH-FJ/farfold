import type { SavedFileFeedback } from "./drafts";
import { feedbackDiskVersion } from "./file_feedback_anchor";
import { VISUAL_FEEDBACK_STRINGS as V } from "./visual_feedback_strings";
import { cellAddress } from "./workbook_view";
import type {
  DocxBlockAnchor,
  XlsxRangeAnchor,
  ImageAreaAnchor,
  PdfAreaAnchor,
  PptxSlideAnchor,
} from "./file_feedback_anchor";
import { formatVisualAreaPercent } from "./visual_area_coordinates";

export const FEEDBACK_STRINGS = {
  saved: (count: number) => `未发送的文件意见（${count}）`,
  previous: "其他内容版本的意见",
  unavailableOwner: (count: number) => `找不到原对话的文件意见（${count}）`,
  unavailableOwnerHint: "可复制保留的意见。每条意见仍对应当时查看的内容。",
  retained:
    "意见仍对应当时查看的内容。可加入输入框，也可以复制；不会自动发送。",
  version: (index: number) => `保留的意见 ${index + 1}`,
  add: "加入输入框",
  copy: "复制意见",
  copied: "意见已复制。",
  copyFailed: "复制未完成，请重试。",
  reportChecking: "正在核对意见对应的内容…",
  reportUnavailable: "未能核对意见对应的内容，请重新打开这份内容。",
  added: "意见已加入这条对话的输入框，尚未发送。",
  textRange: (
    startLine: number,
    endLine: number,
    byteStart: number,
    byteEnd: number,
  ) =>
    `第 ${startLine}${endLine === startLine ? "" : `–${endLine}`} 行，字节 ${byteStart}–${byteEnd}（从 0 起，末位不含），位置未重新核对`,
  workbookRange: (anchor: XlsxRangeAnchor) => {
    const first = cellAddress(anchor.fromRow, anchor.fromColumn);
    const last = cellAddress(anchor.toRow, anchor.toColumn);
    return `工作表 ${JSON.stringify(anchor.sheetName)}（文件内标识 ${JSON.stringify(anchor.sheetId)}），单元格 ${first}${first === last ? "" : `:${last}`}，位置未重新核对`;
  },
  documentBlock: (anchor: DocxBlockAnchor) =>
    `${anchor.blockKind === "table" ? "整个表格" : "整个段落"}，文档内部文件 ${JSON.stringify(anchor.part)}，元素位置 ${JSON.stringify(anchor.elementPath)}（每层从 0 起），位置未重新核对`,
  presentationSlide: (anchor: PptxSlideAnchor) =>
    `当时预览第 ${anchor.previewSlide} / ${anchor.previewSlideCount} 页的整页幻灯片（仅按预览显示的幻灯片计数），位置未重新核对`,
  visualArea: (anchor: ImageAreaAnchor | PdfAreaAnchor) =>
    `${anchor.kind === "pdf-area" ? `第 ${anchor.page} / ${anchor.pageCount} 页，` : ""}以当时显示画面左上角为起点，左 ${formatVisualAreaPercent(anchor.left)}%、上 ${formatVisualAreaPercent(anchor.top)}%、右 ${formatVisualAreaPercent(anchor.right)}%、下 ${formatVisualAreaPercent(anchor.bottom)}%（按显示方向），位置未重新核对`,
} as const;

export function fileFeedbackText(entry: SavedFileFeedback): string {
  const side = entry.selection?.side === "before" ? "修改前" : "修改后";
  const lines = entry.selection
    ? `${entry.selection.line}${entry.selection.endLine && entry.selection.endLine !== entry.selection.line ? `–${entry.selection.endLine}` : ""}`
    : "";
  const location =
    entry.anchor?.kind === "image-area" || entry.anchor?.kind === "pdf-area"
      ? FEEDBACK_STRINGS.visualArea(entry.anchor)
      : entry.anchor?.kind === "text-range"
        ? FEEDBACK_STRINGS.textRange(
            entry.anchor.startLine,
            entry.anchor.endLine,
            entry.anchor.byteStart,
            entry.anchor.byteEnd,
          )
        : entry.anchor?.kind === "xlsx-range"
          ? FEEDBACK_STRINGS.workbookRange(entry.anchor)
          : entry.anchor?.kind === "pptx-slide"
            ? `${FEEDBACK_STRINGS.presentationSlide(entry.anchor)}，文件内定位依据 ${JSON.stringify(entry.anchor.part)}`
            : entry.anchor?.kind === "docx-block"
              ? FEEDBACK_STRINGS.documentBlock(entry.anchor)
              : entry.anchor?.kind === "pdf-page"
                ? `第 ${entry.anchor.page} / ${entry.anchor.pageCount} 页`
                : entry.selection
                  ? entry.scope === "fragment"
                    ? `${side}片段第 ${lines} 行`
                    : entry.scope === "file"
                      ? `${side}第 ${lines} 行`
                      : `当时标记的第 ${lines} 行，位置未重新核对`
                  : entry.lineInput?.text.trim()
                    ? `${entry.lineInput.side === "before" ? "修改前" : "修改后"}${entry.scope === "fragment" ? "片段" : ""}行位置“${entry.lineInput.text.trim()}”（用户填写，尚未核对）`
                    : "";
  const disk = feedbackDiskVersion(entry.path, entry.contentId);
  const exactOpinion =
    entry.anchor?.kind === "text-range" ||
    entry.anchor?.kind === "xlsx-range" ||
    entry.anchor?.kind === "docx-block" ||
    entry.anchor?.kind === "pptx-slide" ||
    entry.anchor?.kind === "image-area" ||
    entry.anchor?.kind === "pdf-area";
  return `关于 ${exactOpinion ? JSON.stringify(entry.path) : entry.path}（当时查看的内容${location ? `，${location}` : ""}）：\n${disk ? `${V.version(disk.sha256)}\n` : ""}${exactOpinion ? entry.text : entry.text.trim()}${disk ? `\n\n${V.verifyVersion}` : ""}`;
}
