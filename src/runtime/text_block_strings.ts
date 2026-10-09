import type {
  TextBlockPreview,
  TextBlockFailureCode,
} from "./text_block_preview";
export const TEXT_BLOCK_STRINGS = {
  title: "文件片段",
  locationScope: "尚未核实文件内容；以下操作只打开或显示当前所选位置。",
  openLocation: "打开所选位置",
  revealLocation: "显示所选位置",
  openedLocation: "已请求打开所选位置；未据此核实文件内容。",
  revealedLocation: "已请求显示所选位置；未据此核实文件内容。",
  locationFailed: "暂时无法操作所选位置，请检查路径与访问权限。",
  previous: "上一片段",
  next: "下一片段",
  position: "片段序号",
  go: "前往",
  cancel: "取消查看",
  retry: "重新读取此片段",
  scope:
    "普通文件最大 256 MiB。每片最多 128 KiB 或 2000 行，不代表一次显示了全文；长行可能跨片。Markdown 按源码显示。",
  range: (b: TextBlockPreview) =>
    `第 ${b.blockIndex + 1} / ${b.blockCount} 片段 · 原文件第 ${b.startLine.toLocaleString()}–${b.endLine.toLocaleString()} 行 · 字节 ${b.byteStart.toLocaleString()}–${b.byteEnd.toLocaleString()}（末位不含）`,
  continuation: (b: TextBlockPreview) =>
    [
      b.startsMidLine ? "开头承接上一片段的同一行" : "",
      b.endsMidLine ? "末行在下一片段继续" : "",
    ]
      .filter(Boolean)
      .join("；"),
  loading: "正在核对完整文件并读取片段…",
  paused: "已取消此次查看，原片段仍保留。已开始的文件读取会继续等待结果。",
  waiting: "文件读取尚未返回，请等待结果后再操作。",
  copy: "复制当前片段",
  copied: "当前片段已复制；未复制其余文件内容。",
  copyFailed: "未能复制当前片段，请重试。",
  feedback:
    "当前只显示文件的一部分。意见对应此文件的已核版本，不附加片段或行号位置。",
  save: "完整文件另存为…",
  saveTitle: "另存完整文件",
  failures: {
    pending:
      "文件读取仍在等待，已暂停后续读取和自动检查。请查看系统访问提示，再明确重试。",
    busy: "已有文件读取尚未结束，本次未开始读取。请稍后重试。",
    changed: "文件已变化，当前仍显示之前的片段。请重新读取文件。",
    tooLarge: "文件超过 256 MiB 的分段查看限制。",
    unsupportedText: "完整文件不是受支持的 UTF-8 文字，不能按片段显示。",
    unreadable: "无法读取文件，请检查位置和访问权限。",
    unavailable: "此次片段读取未能确认，原片段仍保留。",
    invalidBlock: "此片段已不存在，请重新读取文件。",
  } satisfies Record<TextBlockFailureCode, string>,
} as const;
