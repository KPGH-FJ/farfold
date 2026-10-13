import type { XlsxInputResult } from "./xlsx_input_types";
import { XLSX_INPUT_WARNING_TEXT } from "./document_input_strings";
import { xlsxInputWarningCount } from "./document_input_presentation";
import {
  DOCUMENT_INPUT_MAX_BYTES,
  documentTextBytes,
} from "./document_input_types";

/** Exact saved cell content, not a viewport, calculated workbook or image read. */
export function xlsxInputText(input: XlsxInputResult): {
  text: string;
  actualTextChars: number;
} {
  let actualTextChars = 0;
  const authored = (text: string | null) => {
    if (text !== null) actualTextChars += text.replace(/\s/g, "").length;
    return text;
  };
  const records = input.selectedSheets.map((sheet) => ({
    name: input.sheets.find((s) => s.id === sheet.id)!.name,
    state: input.sheets.find((s) => s.id === sheet.id)!.state,
    cells: sheet.cells
      .filter((c) => c.included)
      .map((c) => ({
        address: c.reference,
        type: c.type,
        // SST indices and raw encoded string lexemes are not authored cell text.
        value: authored(
          ["s", "str", "inlineStr"].includes(c.type)
            ? c.text
            : c.cacheState === "missing"
              ? null
              : c.rawValue,
        ),
        storedValueElementPresent: c.rawValue !== null,
        storedTextPresent: c.text !== null,
        ...(c.formula
          ? {
              formula: c.formula.included
                ? {
                    expression: authored(c.formula.text),
                    attributes: c.formula.attributes,
                  }
                : { omitted: true },
              savedCache: c.cacheState,
            }
          : {}),
        ...(c.covered ? { coveredMergeRecord: true } : {}),
        ...(c.visibility === "unknown" ? { visibilityUncertain: true } : {}),
      })),
    merges: sheet.merges,
  }));
  const text = [
    "工作簿单元格内容（文件保存时的已读取内容）",
    input.scope.mode === "all-saved-cells"
      ? "范围：全部工作表，包含保存的隐藏内容。"
      : "范围：全部可见工作表；已知隐藏的单元格及公式文字未加入。",
    "原数字与公式缓存按文件保存内容保留；未重新计算公式，未检查外部数据是否更新。",
    "图片、图表和其他未读取内容不属于本次单元格文字；该文字不代表 Excel 的完整显示效果。",
    ...(input.partial
      ? ["部分内容未读取或范围尚不确定，详见本次确认说明。"]
      : []),
    ...input.warnings.map((w) => {
      return (
        XLSX_INPUT_WARNING_TEXT[w.code] + "（" + xlsxInputWarningCount(w) + "）"
      );
    }),
    JSON.stringify({ date1904: input.date1904, sheets: records }),
  ].join("\n\n");
  documentTextBytes(text, DOCUMENT_INPUT_MAX_BYTES);
  return { text, actualTextChars };
}
