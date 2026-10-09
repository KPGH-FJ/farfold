export const SOURCE_TEXT_SELECTION_STRINGS = {
  source: "原文",
  hint: "选择原文后，可对此选段提意见。",
  keyboard: "按行选择",
  startLine: "起始行",
  endLine: "结束行",
  selectLines: "选择这些行",
  range: (start: number, end: number) => `可选第 ${start}–${end} 行`,
  empty: "原文没有可选择的文字。",
  fragment: "按行选择仅包含当前显示的部分；跨片长行不会选中其余片段。",
  confirm: "对此选段提意见",
  invalid: "未能选择这些行，请检查当前显示范围。",
  selected: (startLine: number, endLine: number) =>
    startLine === endLine
      ? `已选择第 ${startLine} 行中的文字`
      : `已选择第 ${startLine}–${endLine} 行中的文字`,
} as const;
