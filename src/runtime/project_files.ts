import { projectFileUri } from "./file_paths";

export const PROJECT_FILES = {
  loading: "正在扫描文件…",
  cancelling: "正在取消扫描…",
  cancelled: "扫描已取消。",
  cancel: "取消扫描",
  retry: "重新扫描",
  choose: "选择未列出的文件…",
  scope: "扫描范围",
  folder: "请先选择工作文件夹。",
  failed: "未能读取文件列表，可重试或直接选择文件。",
  busy: "本次扫描暂时无法开始，请稍后重试或直接选择文件。",
  pending: "扫描尚未确认结束，可直接选择文件或稍后重试。",
  pendingCancel: "已请求取消扫描，尚未确认结束。",
  cancelFailed: "未能确认取消，仍在等待扫描结果。",
  partial: "部分位置无法读取，下面的结果不完整。",
  truncated: "已达到扫描范围，下面仅列出部分文件。",
  noMatch: "已扫描的文件中没有匹配项。",
  matchesLimited: "仅显示前 50 个匹配项，可继续输入文件名缩小范围。",
  excluded: "跳过的目录名",
  skipped: "实际跳过目录",
  unreadable: "未能读取的目录 / 条目",
  names: "无法表示的文件名",
  budget:
    "最多 2,000 个文件、10 层子目录；单目录 4,096 条、总计 20,000 条、2,000 个目录，路径文字合计 1 MiB。扫描通常在 5 秒内结束；系统文件读取可能继续等待。",
} as const;

export const PROJECT_FILE_LIMIT_REASONS = {
  fileLimit: "文件数量",
  depthLimit: "目录深度",
  entryLimit: "总条目数量",
  directoryEntryLimit: "单目录条目数量",
  directoryLimit: "目录数量",
  pathBytesLimit: "路径文字容量",
  timeLimit: "扫描时间",
} as const;

export type ProjectFilesResult = {
  requestId: string;
  files: string[];
  truncated: boolean;
  partial: boolean;
  cancelled: boolean;
  limits: {
    files: number;
    depth: number;
    entries: number;
    entriesPerDirectory: number;
    directories: number;
    pathBytes: number;
    timeMs: number;
  };
  counts: {
    entries: number;
    directories: number;
    skippedDirectories: number;
    unreadableDirectories: number;
    unreadableEntries: number;
    unsupportedNames: number;
  };
  limitReasons: (keyof typeof PROJECT_FILE_LIMIT_REASONS)[];
  excludedDirectoryNames: string[];
};

/** The picker accepts only a bounded result for this exact request. Paths are
 * still checked again when an attachment is read or sent. */
export function projectFilesResult(
  value: unknown,
  requestId: string,
  cwd: string,
): ProjectFilesResult {
  if (!value || typeof value !== "object") throw new Error("invalid result");
  const r = value as ProjectFilesResult;
  if (
    r.requestId !== requestId ||
    !Array.isArray(r.files) ||
    r.files.length > 2000 ||
    ![r.truncated, r.partial, r.cancelled].every(
      (v) => typeof v === "boolean",
    ) ||
    !r.limits ||
    !r.counts ||
    ![
      "files",
      "depth",
      "entries",
      "entriesPerDirectory",
      "directories",
      "pathBytes",
      "timeMs",
    ].every(
      (key) =>
        Number.isSafeInteger(r.limits[key as keyof typeof r.limits]) &&
        r.limits[key as keyof typeof r.limits] > 0,
    ) ||
    ![
      "entries",
      "directories",
      "skippedDirectories",
      "unreadableDirectories",
      "unreadableEntries",
      "unsupportedNames",
    ].every(
      (key) =>
        Number.isSafeInteger(r.counts[key as keyof typeof r.counts]) &&
        r.counts[key as keyof typeof r.counts] >= 0,
    ) ||
    !Array.isArray(r.limitReasons) ||
    r.limitReasons.length > 7 ||
    !r.limitReasons.every((v) =>
      Object.hasOwn(PROJECT_FILE_LIMIT_REASONS, v),
    ) ||
    !Array.isArray(r.excludedDirectoryNames) ||
    r.excludedDirectoryNames.length > 64 ||
    !r.excludedDirectoryNames.every(
      (v) => typeof v === "string" && v.length <= 100,
    )
  )
    throw new Error("invalid result");
  let bytes = 0;
  for (const path of r.files) {
    if (typeof path !== "string") throw new Error("invalid path");
    bytes += new TextEncoder().encode(path).byteLength;
    if (bytes > 1048576) throw new Error("oversized paths");
    projectFileUri(cwd, path);
  }
  return r;
}

export function projectFilesError(value: unknown): string {
  const code =
    value && typeof value === "object" && "code" in value
      ? value.code
      : undefined;
  if (code === "cancelled") return PROJECT_FILES.cancelled;
  if (code === "readPending") return PROJECT_FILES.pending;
  if (code === "readBusy") return PROJECT_FILES.busy;
  return PROJECT_FILES.failed;
}
