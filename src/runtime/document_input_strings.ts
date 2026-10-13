import { DOCUMENT_STRINGS } from "./document_strings";
import type { XlsxInputWarningCode } from "./xlsx_input_types";

export const XLSX_INPUT_WARNING_TEXT: Record<XlsxInputWarningCode, string> = {
  hiddenCellsOmitted: "隐藏工作表、行、列或明确不显示的单元格没有加入。",
  hiddenFormulasOmitted:
    "受保护的隐藏公式文字没有加入；已保存的结果仍按所选范围读取。",
  unknownVisibility: "有单元格的显示范围尚未确认，不能据此还原当前可见表格。",
  coveredMergeData:
    "合并区域中被覆盖的单元格仍有保存内容；按本次所选范围省略或单独加入。",
  savedFormulaCaches: "公式结果来自文件保存的内容，没有重新计算。",
  missingFormulaCaches: "有公式没有保存结果，不能提供其当前计算值。",
  formulaTextNotStored: "有单元格未保存完整公式文字，不能据保存结果还原公式。",
  unsupportedFormula: "有未支持的公式形式，仅读取能够核实的保存内容。",
  numberDisplayUnknown: "保留原保存数字，部分数字的显示形式尚未确认。",
  styleDisplayUnknown: "有未支持的显示规则，不能保证与表格软件当前显示一致。",
  conditionalFormatting: "没有执行条件格式，当前颜色、显隐和显示形式可能不同。",
  definedNames: "保存的名称定义没有加入。",
  drawings: "绘图内容没有加入。",
  images: "图片像素没有加入。",
  charts: "图表内容没有加入。",
  pivotTables: "数据透视内容没有加入。",
  externalContent: "外部来源的内容未读取，没有获取外部数据。",
  unsupportedContent: "有尚未支持的内容未读取，不能据此还原完整工作簿。",
  unsupportedAssets: "嵌入文件及其他尚未支持的内容没有加入。",
  macrosNotExecuted: "没有执行宏，也没有加入宏代码。",
  recalculationRequested:
    "文件标记需要重新计算；本次没有执行计算，保存结果可能过时。",
};

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
  xlsxScope:
    "加入所选范围内保存的单元格内容、公式文字和已有结果；没有重新计算、执行宏或获取外部数据。图片、图表及未支持内容不加入。",
  xlsxRange: "读取范围",
  xlsxVisible: "可见工作表中的保存单元格",
  xlsxAll: "全部工作表中的保存单元格（含隐藏内容）",
  xlsxVisibleDetails:
    "排除隐藏工作表、隐藏行列及能确认不显示的单元格；受保护的隐藏公式文字不加入。不能确认的显示规则会单独说明。",
  xlsxAllDetails:
    "包含隐藏工作表、行列、单元格和保存的公式文字；仅加入文件保存的内容，不读取外部来源。切换范围会重新读取，确认前请查看全部文字。",
  xlsxSavedScope: "已确认的读取范围",
  xlsxSheetCount: (count: number) => `本次读取 ${count} 个工作表。`,
  xlsxCount: (bytes: number) => `文字表示 ${bytes.toLocaleString()} 字节。`,
  xlsxScopeEmpty:
    "所选范围没有可读取的工作表；可明确选择包含隐藏内容后重新读取。",
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
    if (code === "scopeEmpty") return DOCUMENT_INPUT_STRINGS.xlsxScopeEmpty;
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
