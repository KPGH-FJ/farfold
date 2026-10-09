export const VISUAL_FEEDBACK_STRINGS = {
  currentPage: (page: number) => `针对当前第 ${page} 页`,
  wholeFile: "针对整个文件",
  pageTarget: (page: number, pages: number) =>
    `意见针对第 ${page} / ${pages} 页`,
  fileTarget: "意见针对整个文件",
  retained: "意见保留原来的页码和内容版本，翻页不会改变意见目标。",
  version: (digest: string) => `文件 SHA-256：${digest}`,
  verifyVersion: "此意见针对上述版本；若文件已变化，请先核对位置与内容。",
} as const;
