import type { PdfInputResult } from "./pdf_input_types";
import { checkedPdfInputResult, pdfInputUtf8 } from "./pdf_input_validation";

export const PDF_INPUT_SCOPE_TEXT = {
  decodedTextOnly:
    "只加入提取到的页面文字；图片、图表的完整内容，以及批注和表单内容未读取。",
  visibilityUnverified:
    "可能包含页面上看不见的文字；页外或裁切范围外的文字也可能缺失，不能视为全部保存文字。",
  readingOrderUnverified:
    "按文件页序和提取到的文字片段顺序保留，阅读顺序和显示效果不保证与原文一致。",
  textDecodingUnverified:
    "文字还原可能有误；保留提取结果，不猜测或替换文字，也不自动识别图片文字。",
} as const;

/** Every page and item, never a viewport, excerpt, or visual completeness claim. */
export function pdfInputText(value: PdfInputResult): {
  text: string;
  actualTextChars: number;
} {
  const result = checkedPdfInputResult(value);
  let actualTextChars = 0;
  for (const page of result.pages)
    for (const item of page.items)
      actualTextChars += item.text.replace(/\s/gu, "").length;
  const text = [
    "PDF 提取文字（按原页码和文字片段顺序保留）",
    "范围：全部页面中可提取的文字，已明确选择包含可能不可见的文字；该结果仅为部分内容。",
    ...result.warnings.map((w) =>
      w.code === "pagesWithoutText"
        ? `有 ${w.count} 页未提取到文字，未自动识别图片。`
        : PDF_INPUT_SCOPE_TEXT[w.code],
    ),
    JSON.stringify({ pages: result.pages }),
  ].join("\n\n");
  pdfInputUtf8(text);
  return { text, actualTextChars };
}
