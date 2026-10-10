import { FILE_DELIVERY_STRINGS as D } from "./file_delivery_strings";
import { DocxError, type DocxWarningCode } from "./docx_types";
import type { DocxBlockAnchor } from "./file_feedback_anchor";

export const DOCUMENT_STRINGS = {
  title: "文档预览",
  loading: "正在读取文档…",
  paused: "文档预览已暂停。",
  cancelled: "已取消本次预览。",
  cancel: "取消预览",
  retry: "重新预览",
  snapshot: "只读预览，显示文件保存时的内容。字段不重新计算。",
  layout:
    "内容连续显示，保留支持的文字、列表、表格和图片；尺寸与间距适配预览，不还原 Word 分页。",
  sections: "文档区域",
  body: "正文",
  header: "页眉",
  footer: "页脚",
  footnote: "脚注",
  endnote: "尾注",
  noteId: (id: string) => `原标记 ${id}`,
  separateStory: "此区域单独显示，不代表其在原文档中的页码或重复位置。",
  warnings: "预览范围说明",
  partial: "部分内容无法显示；缺失位置和原因已注明。",
  empty: "此区域没有可显示的正文。",
  previous: "上一部分",
  next: "下一部分",
  part: (n: number, total: number) => `内容第 ${n} / ${total} 部分`,
  paragraphPart: (n: number, total: number) => `长段落第 ${n} / ${total} 部分`,
  paragraphSplit: "长段落分段显示，切换可查看其余内容。",
  table: "表格",
  selectParagraph: "选择整个段落",
  selectTable: "选择整个表格",
  feedbackParagraph: "对此段落提意见",
  feedbackTable: "对此表格提意见",
  cancelSelection: "取消选择",
  feedbackParagraphScope: "意见针对整个原段落，包括分段显示的其余内容。",
  feedbackTableScope: "意见针对整个原表格，包括当前范围以外的行列。",
  feedbackTarget: (anchor: DocxBlockAnchor) =>
    `意见针对当时文档中的${anchor.blockKind === "paragraph" ? "整个段落" : "整个表格"}`,
  feedbackRetained:
    "意见保留当时的文档位置和文件版本；查看其他内容不会改变目标，明确提意见才更换。",
  tableRange: (r: number, end: number, c: number, last: number) =>
    `当前显示第 ${r}–${end} 行，第 ${c}–${last} 列`,
  tableScope: "表格按范围显示。单元格较长时显示摘要，可打开完整内容。",
  previousRows: "上一组行",
  nextRows: "下一组行",
  previousColumns: "上一组列",
  nextColumns: "下一组列",
  cell: (r: number, c: number) => `第 ${r} 行，第 ${c} 列`,
  openCell: (r: number, c: number) => `查看第 ${r} 行、第 ${c} 列完整内容`,
  merge: (r: number, c: number, rows: number, columns: number) =>
    `合并范围：第 ${r}–${r + rows - 1} 行，第 ${c}–${c + columns - 1} 列`,
  clippedMerge: "合并范围跨越当前显示范围。内容属于原起始单元格。",
  cellSummary: "内容摘要；打开查看全部",
  backTable: "返回表格",
  nestedTable: "内含表格",
  image: "文档图片",
  imageFailed: "此图片未能显示，不能将当前预览视为完整内容。",
  manualBreak: "文档中的手动分页位置",
  failed: "无法预览此文档。可重新读取文件，或使用其他应用打开。",
  invalid: "此文档结构无法读取，请使用其他应用检查文件。",
  unsupported: "暂不支持此文档内容，请使用其他应用打开。",
  limit: "此文档超过预览大小或复杂度限制，请使用其他应用打开。",
  encrypted: "此文档已加密，请使用其他应用打开。",
  changed: "文件已变化，请重新读取后再预览。",
  unreadable: "无法读取此文档，请核对文件位置与访问权限。",
  readPending: D.checkWaitExpired,
  readBusy: D.checkBusy,
  timeout: "文档预览等待超时，可重试或使用其他应用打开。",
  busy: "另一份文档仍在处理，请稍后重试。",
} as const;

export const DOCUMENT_WARNINGS: Record<DocxWarningCode, string> = {
  continuousLayout: "原有分页、页面尺寸和打印排版未还原。",
  fontSubstitution: "文字使用本机可用字体，可能与原字体不同。",
  unsupportedFormatting: "部分格式已简化，不能完整还原。",
  hyperlinks: "超链接显示文字，不打开链接。",
  cachedFields: "字段仅显示保存的结果，内容可能尚未更新。",
  missingFieldResult: "部分字段没有保存结果，缺失位置已注明。",
  hiddenContent: "隐藏文字未显示，缺失位置已注明。",
  externalImages: "外部图片未加载。",
  missingImage: "部分图片资源缺失。",
  unsupportedImage: "部分图片格式暂不支持。",
  unsupportedDrawing: "部分绘图或文本框暂未显示。",
  unsupportedContent: "部分文档内容暂未显示。",
  sectionLayout: "分节、分栏和区域位置按连续内容显示。",
  comments: "批注内容暂未显示。",
  listFormat: "部分列表标记无法完整还原。",
};

export function documentFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  if (message === D.checkBusy || message === D.checkWaitExpired) return message;
  return error instanceof DocxError
    ? DOCUMENT_STRINGS[error.code]
    : DOCUMENT_STRINGS.failed;
}
