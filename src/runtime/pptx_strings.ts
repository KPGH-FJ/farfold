import { FILE_DELIVERY_STRINGS as D } from "./file_delivery_strings";
import { PptxError, type PptxWarningCode } from "./pptx_types";

export const PPTX_STRINGS = {
  title: "幻灯片预览",
  loading: "正在读取幻灯片…",
  paused: "幻灯片预览已暂停。",
  cancelled: "已取消本次预览。",
  cancel: "取消预览",
  retry: "重新预览",
  snapshot: "只读预览，显示文件保存时的内容。",
  scope:
    "支持普通 PPTX 的文字、矩形、椭圆、内嵌 PNG、JPEG 图片及其平移、缩放组合；不播放动画，不打开文档中的链接。字体和文字排版可能与原应用不同。",
  partial: "部分内容或格式未显示，请同时核对原文件。",
  previous: "上一页",
  next: "下一页",
  select: "选择幻灯片",
  selectFeedback: "选择当前幻灯片",
  confirmFeedback: "对此页提出意见",
  cancelFeedback: "取消选择",
  feedbackScope: "针对当前显示的整页幻灯片；部分预览不代表完整内容。",
  feedbackRetained: "意见保留当时的幻灯片与文件版本，翻页不会改变意见目标。",
  page: (page: number, total: number) => `第 ${page} / ${total} 页`,
  slide: (page: number) => `第 ${page} 页幻灯片`,
  image: "幻灯片图片",
  imageFailed: "此图片未能显示，当前预览不完整。可重新预览或使用其他应用打开。",
  failed: "无法预览此演示文稿。可重新读取文件，或使用其他应用打开。",
  invalid: "此演示文稿结构无法读取，请使用其他应用检查文件。",
  unsupported: "暂不支持此演示文稿中的内容，请使用其他应用打开。",
  limit: "此演示文稿超过预览大小或复杂度限制，请使用其他应用打开。",
  encrypted: "此演示文稿已加密，请使用其他应用打开。",
  changed: "文件已变化，请重新读取后再预览。",
  unreadable: "无法读取此演示文稿，请核对文件位置与访问权限。",
  readPending: D.checkWaitExpired,
  readBusy: D.checkBusy,
  timeout: "幻灯片预览等待超时，可重试或使用其他应用打开。",
  busy: "另一份演示文稿仍在处理，请稍后重试。",
} as const;
export const PPTX_WARNINGS: Record<PptxWarningCode, string> = {
  fontSubstitution: "文字使用本机可用字体，可能与原字体不同。",
  unsupportedFormatting: "部分格式未能还原。",
  unsupportedContent: "部分内容未显示。",
  hiddenContent: "隐藏内容未显示。",
  hyperlinks: "超链接仅显示文字，不打开链接。",
};
export function pptxFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  if (message === D.checkWaitExpired || message === D.checkBusy) return message;
  return error instanceof PptxError
    ? PPTX_STRINGS[error.code]
    : PPTX_STRINGS.failed;
}
