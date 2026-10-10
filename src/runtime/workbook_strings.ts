import { FILE_DELIVERY_STRINGS as D } from "./file_delivery_strings";
import type { XlsxRangeAnchor } from "./file_feedback_anchor";
import { cellAddress } from "./workbook_view";
import { XlsxError, type XLSX_WARNING_CODES } from "./xlsx_types";

export const WORKBOOK_STRINGS = {
  title: "表格预览",
  loading: "正在读取表格…",
  paused: "表格预览已暂停。",
  cancelled: "已取消本次预览。",
  cancel: "取消预览",
  retry: "重新预览",
  snapshot: "只读预览，显示文件保存时的内容。公式不重新计算。",
  layout:
    "每次显示最多 100 行、24 列，尺寸会适配预览。可翻页或输入单元格位置。",
  sheet: "工作表",
  hidden: "隐藏",
  veryHidden: "深度隐藏",
  showHidden: "显示隐藏行列",
  address: "单元格位置",
  jump: "前往",
  invalidAddress: "请输入有效位置，例如 A1 或 XFD1048576。",
  previousRows: "上一组行",
  nextRows: "下一组行",
  previousColumns: "上一组列",
  nextColumns: "下一组列",
  emptyWindow: "当前范围没有可见行列。可前往其他位置或显示隐藏行列。",
  warnings: "预览范围说明",
  detail: "单元格内容",
  closeDetail: "收起单元格内容",
  feedbackCell: "对此单元格提意见",
  feedbackMerge: "对整个合并范围提意见",
  feedbackTarget: (anchor: XlsxRangeAnchor) => {
    const first = cellAddress(anchor.fromRow, anchor.fromColumn);
    const last = cellAddress(anchor.toRow, anchor.toColumn);
    return `意见针对工作表“${anchor.sheetName}”的 ${first === last ? first : `${first}:${last}`}`;
  },
  feedbackRetained:
    "意见保留当时的工作表、位置和文件版本；查看其他单元格不会改变目标，明确提意见才更换。",
  value: "保存的值",
  formatted: "显示值",
  formula: "公式",
  noFormulaText: "文件未保存此单元格的完整公式文本。",
  blank: "空单元格",
  emptyText: "空文本",
  emptyDisplay: "空白显示值",
  missingCache: "未保存计算结果",
  unsupportedFormat: "暂不支持此数字格式，显示保存的原值",
  dateRange: "日期超出预览范围，显示保存的原值",
  widthDependentFormat: "此格式依赖列宽，显示保存的原值",
  isoDateValue: "此日期保留文件中的原值",
  unknownFormat: "此格式无法完整显示，显示保存的原值",
  partialMerge: "合并范围跨越当前显示范围",
  hiddenMerge: "合并范围的起始单元格已隐藏",
  range: (from: string, to: string) => `当前范围 ${from}–${to}`,
  merged: (from: string, to: string) => `合并范围 ${from}–${to}`,
  selected: (address: string) => `单元格 ${address}`,
  failed: "无法预览此表格。可刷新文件，或使用其他应用打开。",
  limit: "此表格超过预览大小或复杂度限制，请使用其他应用打开。",
  unsupported: "暂不支持此表格内容，请使用其他应用打开。",
  timeout: "表格预览等待超时，可重试或使用其他应用打开。",
  busy: "另一份表格仍在处理，请稍后重试。",
  changed: "文件已变化，请刷新文件后重新预览。",
  encrypted: "此表格已加密，请使用其他应用打开。",
  unreadable: "无法读取此表格，请核对文件位置与访问权限后刷新。",
  readPending: D.checkWaitExpired,
  readBusy: D.checkBusy,
} as const;

export const WORKBOOK_WARNINGS: Record<
  (typeof XLSX_WARNING_CODES)[number],
  string
> = {
  automaticColor: "自动颜色使用预览默认值。",
  unsupportedColor: "部分颜色无法还原。",
  underlineVariant: "部分下划线简化显示。",
  fontVerticalAlignment: "上标和下标暂未显示。",
  customIndexedColors: "自定义颜色表暂未完整显示。",
  differentialStyles: "动态格式暂未显示。",
  unknownNumberFormat: "部分数字格式无法还原；单元格会注明。",
  patternFill: "图案填充暂未完整显示。",
  borderStyle: "部分边框样式简化显示。",
  diagonalBorder: "斜线边框暂未显示。",
  alignment: "部分对齐方式简化显示。",
  rotatedText: "旋转文字按水平文字显示。",
  shrinkToFit: "缩小字体适应单元格的效果暂未显示。",
  phoneticText: "注音信息暂未显示。",
  cachedFormulas: "公式显示已保存的计算结果；结果可能尚未更新，缺失时会注明。",
  formulaVariant: "部分公式仅能显示已保存的结果，完整公式文本可能缺失。",
  columnLayout: "部分列布局按预览尺寸显示。",
  rowOutline: "行分组和折叠层级暂未显示。",
  sheetProperties: "部分工作表属性未在预览中显示。",
  sheetDefaults: "部分默认行列尺寸按预览尺寸显示。",
  sheetViews: "冻结窗格和原有视图设置暂未还原。",
  conditionalFormatting: "条件格式暂未显示。",
  dataValidation: "数据验证规则暂未显示。",
  hyperlinks: "超链接仅显示单元格文字。",
  printLayout: "打印排版暂未显示。",
  autoFilter: "筛选条件暂未应用。",
  sheetProtection: "此处只读，未提供工作表保护设置。",
  tables: "表格对象的样式和筛选暂未显示。",
  unsupportedSheetContent: "文件含有尚未支持的工作表内容。",
  externalRelationships: "外部内容未加载。",
  images: "表格中的图片暂未显示。",
  charts: "表格中的图表暂未显示。",
  pivotTables: "数据透视表未重新计算。",
  externalLinks: "其他文件中的数据未加载。",
  embeddedObjects: "嵌入对象暂未显示。",
  macrosNotExecuted: "宏未执行。",
  recalculationRequested: "此文件要求重新计算，已保存的公式结果可能过时。",
};

export function workbookFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  if (message === D.checkBusy || message === D.checkWaitExpired) return message;
  if (!(error instanceof XlsxError)) return WORKBOOK_STRINGS.failed;
  const code = error.code;
  return code === "invalid" ? WORKBOOK_STRINGS.failed : WORKBOOK_STRINGS[code];
}

export function workbookFormatIssue(code: string | undefined): string | null {
  if (!code) return null;
  const S = WORKBOOK_STRINGS;
  switch (code) {
    case "missingCache":
      return S.missingCache;
    case "unsupportedFormat":
      return S.unsupportedFormat;
    case "dateRange":
      return S.dateRange;
    case "widthDependentFormat":
      return S.widthDependentFormat;
    case "isoDateValue":
      return S.isoDateValue;
    default:
      return S.unknownFormat;
  }
}
