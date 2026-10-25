import type { DocxSearchLocation } from "./docx_search_text";
import type { XlsxSearchLocation } from "./xlsx_search_text";
import type { PdfSearchLocation } from "./pdf_search_text";
import type { PdfInputWarning } from "./pdf_input_types";
import type { XlsxInputWarning } from "./xlsx_input_types";
import type { PptxSearchLocation } from "./attachment_search_pptx";
import type { PptxWarning } from "./pptx_types";
import { PPTX_WARNINGS } from "./pptx_strings";
import { XLSX_INPUT_WARNING_TEXT } from "./document_input_strings";
import { xlsxInputWarningCount } from "./document_input_presentation";
import { DOCUMENT_WARNINGS } from "./document_strings";

const regions = {
  body: "正文",
  header: "页眉",
  footer: "页脚",
  footnote: "脚注",
  endnote: "尾注",
} as const;

export const ATTACHMENT_SEARCH_STRINGS = {
  scope: "所选附件内容",
  title: "查找当前附件文件",
  query: "搜索所选附件内容…",
  boundary:
    "只查找你明确选择的当前本地文字、DOCX、XLSX、PDF 或 PPTX 文件，不代表附件当时的历史内容。不会加载历史、连接 Agent 或读取网页。",
  limits:
    "每次最多 20 个文件；每个源文件最多 1 MiB，实际可检索文字合计最多 16 MiB。支持 UTF-8 纯文字、DOCX 作者文字、XLSX 所列保存内容、PDF 可提取的页面文字及 PPTX 已解析的预览文字；不识别图片或音频内容。",
  pptxCandidate: "按 PPTX 查找已解析的预览文字（仅为部分内容）",
  pptxDetails: "PPTX 查找范围说明",
  pptxScope:
    "只查找可解析幻灯片的预览文字；未解析和隐藏内容、备注、图片文字及图表完整内容不参与。不能保证原应用的可见文字或阅读顺序。",
  pptxFormatting:
    "可能包含依源格式生成的项目符号和间隔，并非作者逐字全文或源字符位置。",
  pptxBarriers: "按幻灯片、对象、段落及换行分别查找，不跨这些边界拼接文字。",
  pptxPartial:
    "PPTX 始终仅查找已解析的预览文字；没有匹配不代表完整演示文稿没有匹配。",
  pptxSlides: (n: number) => `本次解析 ${n} 页预览的文字，不代表源文件页码。`,
  pptxImages: (n: number) => `${n} 处图片未作文字识别。`,
  pptxLocation: (
    page: number,
    total: number,
    shape: number,
    paragraph: number,
    segment: number,
  ) =>
    `预览 ${page}/${total} · 对象 ${shape} · 段落 ${paragraph} · 片段 ${segment}`,
  pdfCandidate:
    "按 PDF 读取全部页面可提取文字（可能含不可见文字，仅为部分内容）",
  pdfScope:
    "全部页面中可提取的文字，可能包含页面上看不见的文字；不识别图片文字，不保证视觉可见性、阅读顺序或文字还原准确性。",
  pdfPartial:
    "PDF 仅查找各页提取到的文字片段，始终只是部分内容；没有匹配不代表完整文件没有匹配。",
  pdfBarriers:
    "只连接符合位置条件的相邻水平文字片段；其余分别查找，被分开的词仍可能无法匹配。",
  pdfLimits:
    "每份 PDF 最多处理 1,000 页，完整文字表示最多 256 KiB；超限时整份不参与查找。",
  pdfPages: (n: number) => `本次处理 ${n} 页的可提取文字。`,
  pdfLocation: (page: number, item: number, last?: number) =>
    `第 ${page} 页 · 提取片段 ${item}${last !== undefined && last !== item ? `至${last}` : ""}`,
  pdfWarnings: {
    decodedTextOnly: "图片、图表的完整内容，以及批注和表单内容未读取。",
    visibilityUnverified:
      "可能包含不可见文字，也可能缺少页外或裁切范围外的文字。",
    readingOrderUnverified: "文字片段顺序和显示效果不保证与原文一致。",
    textDecodingUnverified:
      "保留实际文字还原结果，不猜测或替换文字，也不自动识别图片文字。",
    pagesWithoutText: "有页面未提取到文字，没有自动识别图片文字。",
  },
  docxCandidate: "按 DOCX 读取作者文字（文件类型声明或 .docx 位置）",
  xlsxCandidate: "按 XLSX 读取可见工作表中符合范围的保存内容",
  xlsxScope:
    "XLSX 仅查找可见工作表中符合范围的单元格值、保存缓存和公式文字；隐藏、可见性未知及合并覆盖的内容不参与查找，不代表 Excel 的完整显示效果。",
  xlsxCache:
    "单元格和公式结果来自文件保存的内容，可能不是最新；不重新计算公式，不展开共享公式，也不更新外部数据。",
  xlsxPartial:
    "XLSX 存在省略内容或未确认的范围；没有匹配不代表完整工作簿没有匹配。",
  xlsxFields: {
    value: "保存值",
    savedCache: "保存的公式结果",
    formula: "保存的公式文字",
  },
  xlsxCell: (row: number, column: number) => `第 ${row} 行、第 ${column} 列`,
  textCandidate: "按 UTF-8 纯文字读取",
  docxScope:
    "DOCX 已提取作者文字；段落、单元格和文档区域分别查找，不代表 Word 视觉页码。",
  docxPartial:
    "仅查找已提取的作者文字，存在省略内容；没有匹配不代表完整文档没有匹配。",
  docxImages: (n: number) => `${n} 处图片及其替代文字不参与查找。`,
  docxRegions: regions,
  docxWarnings: {
    ...DOCUMENT_WARNINGS,
    hiddenContent: "隐藏文字未参与查找。",
    missingFieldResult: "部分字段没有保存结果，未参与查找。",
  },
  docxParagraph: (n: number) => `段落 ${n}`,
  docxCell: (table: number, row: number, column: number) =>
    `表格 ${table} · 第 ${row} 行、第 ${column} 列`,
  docxNote: (id: string) => `原标记 ${id}`,
  choose: "选择要读取的当前文件",
  start: "开始查找附件",
  retry: "重新检查所选附件",
  clearInvalidSelection: "清除失效选择",
  cancel: "取消本次附件查找",
  emptyCandidates: "当前范围没有已加载的消息附件。",
  notLocal: "没有可供本次读取的本地文件位置",
  currentFile: "当前本地文件",
  received: "消息中声明的附件",
  user: "用户消息",
  agent: "回复",
  selected: (n: number) => `已选择 ${n} 个文件`,
  coverage: (unloaded: number, unavailable: number, omitted: number) =>
    `${unloaded} 个对话尚未加载 · ${unavailable} 个对话的读取尚未确认${omitted ? ` · ${omitted} 个附件未列出，请缩小范围` : ""}`,
  enter: "输入关键词并选择文件，再开始查找。",
  invalid: "请使用有效关键词（最多 256 个文字字节），并重新选择文件。",
  invalidQuery:
    "关键词最多 256 个 UTF-8 字节，且不能包含控制字符。请缩短或修改关键词。",
  reading: "正在读取所选当前文件…",
  cancelling: "已撤回本次查找，正在等待已开始的读取返回…",
  cancelled: "本次查找已撤回，未展示迟到结果。",
  stale: "本次结果已失效，请重新选择并查找。",
  pending:
    "后台文件读取状态尚未确认，本次不会继续或自动重试。稍后可明确重新检查所选附件；尚未结束的读取仍会限制新检查。",
  previousPending:
    "此前的后台读取是否结束仍未确认；以下仅表示本次明确重新检查的进度和结果。",
  complete: "本次附件查找已结束",
  results: "当前文件的匹配片段",
  empty: "已检索文字中没有匹配；未读取文件不在此结论范围。",
  summary: (
    searched: number,
    total: number,
    matches: number,
    displayed: number,
  ) =>
    `已检索 ${searched}/${total} 个文件的所列文字范围 · ${matches} 处匹配 · 显示 ${displayed} 处`,
  omittedHits: (n: number) => `${n} 处匹配未展示，请缩小范围或补充关键词。`,
  details: "文件范围与读取结果",
  navigate: "前往来源附件",
  checking: "正在核对当前文件…",
  locationHint: "片段来自本次读取的当前文件；前往附件不会把片段当成对话正文。",
  located: "已定位到来源附件；文件匹配片段仍以本次查找为准。",
  locating: "正在定位来源附件…",
  close: "关闭附件定位",
  rowStates: {
    queued: "尚未读取",
    checking: "正在核实文件",
    reading: "正在读取文件",
    searched: "所列文字范围已检索",
    error: "未能检索",
    skipped: "未检索",
  },
  errors: {
    changed: "内容、位置或来源已变化，请重新选择。",
    unreadable: "无法读取此文件。",
    tooLarge: "完整文件超过 1 MiB。",
    unsupported: "不是本次支持的 UTF-8 纯文字、DOCX、XLSX、PDF 或 PPTX 内容。",
    budget: "超过本次 16 MiB 可检索正文限额，未用于检索。",
    pending: "读取尚未返回，后台状态未确认。",
    busy: "已有文件读取或文档处理尚未结束，本文件未完成检索。",
    documentLimit: "文档超过解析大小或复杂度限制，未用于检索。",
    encrypted: "此文档已加密，未用于检索。",
    timeout: "文档处理等待超时，本次未完成；可明确重新查找。",
    invalid: "返回内容无法确认，未用于检索。",
    pdfNoText:
      "此 PDF 未提取到可搜索文字；没有识别图片文字，不能据此判断文件没有内容。",
    pdfIncomplete: "未能可靠读取整份 PDF 的文字，未用于检索。",
    scopeEmpty:
      "此工作簿没有可见工作表，本次没有可读取的范围；未改为读取隐藏内容。",
  },
} as const;

export function docxSearchLocationLabel(location: DocxSearchLocation): string {
  const s = ATTACHMENT_SEARCH_STRINGS;
  return [
    `${s.docxRegions[location.region]}${location.regionIndex ? ` ${location.regionIndex}` : ""}${location.noteId !== undefined ? `（${s.docxNote(location.noteId)}）` : ""}`,
    ...location.cells.map((cell) =>
      s.docxCell(cell.table, cell.row, cell.column),
    ),
    s.docxParagraph(location.paragraph),
  ].join(" · ");
}

export function attachmentSearchLocationLabel(
  location:
    | DocxSearchLocation
    | XlsxSearchLocation
    | PdfSearchLocation
    | PptxSearchLocation,
): string {
  if (!("kind" in location)) return docxSearchLocationLabel(location);
  const s = ATTACHMENT_SEARCH_STRINGS;
  if (location.kind === "pptx")
    return s.pptxLocation(
      location.previewSlide,
      location.previewTotal,
      location.shape,
      location.paragraph,
      location.segment,
    );
  if (location.kind === "pdf")
    return s.pdfLocation(
      location.pageNumber,
      location.itemIndex + 1,
      location.itemRanges
        ? location.itemRanges.at(-1)!.itemIndex + 1
        : undefined,
    );
  return [
    location.sheetName,
    location.reference,
    s.xlsxCell(location.row, location.column),
    s.xlsxFields[location.field],
  ].join(" · ");
}

export function pptxSearchWarningLabel(warning: PptxWarning): string {
  return `${PPTX_WARNINGS[warning.code]}（${warning.count}）`;
}

export function xlsxSearchWarningLabel(warning: XlsxInputWarning): string {
  return `${XLSX_INPUT_WARNING_TEXT[warning.code]}（${xlsxInputWarningCount(warning)}）`;
}
export function pdfSearchWarningLabel(warning: PdfInputWarning): string {
  const text = ATTACHMENT_SEARCH_STRINGS.pdfWarnings[warning.code];
  return warning.unit === "pages" ? `${text}（${warning.count} 页）` : text;
}
