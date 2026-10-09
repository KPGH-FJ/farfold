import type { VerifiedFile, VisualPreview } from "./file_delivery";
import { inspectImageBytes } from "./image_bytes";

export const VISUAL_PREVIEW_STRINGS = {
  loading: "正在读取预览…",
  rendering: "正在显示页面…",
  failed: "未能预览这份文件。内容可能损坏、格式不受支持，或超过当前预览限制。",
  changed: "文件版本已变化，请重新读取。",
  timeout: "预览尚未返回，已停止等待。可重新读取或使用其他应用打开。",
  password: "这份 PDF 需要密码，暂不能在这里预览。可使用其他应用打开。",
  limit: "文件超过当前预览限制，可使用其他应用打开。",
  busy: "其他预览正在结束，请稍后重新读取。",
  unsupported:
    "当前环境或这份 PDF 的绘制方式暂不支持内嵌预览，请使用其他应用打开。",
  cancelled: "预览已取消。",
  paused: "预览已暂停。",
  cancel: "取消预览",
  previous: "上一页",
  next: "下一页",
  page: (page: number, total: number) => `第 ${page} / ${total} 页`,
  snapshot: "当前显示的是已读取的文件版本。",
} as const;
export const MAX_VISUAL_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_PAGES = 1000;
export const MAX_PREVIEW_PIXELS = 16_777_216;
export const MAX_PREVIEW_EDGE = 8192;
export const PREVIEW_WAIT_MS = 15_000;

export function visualFileKind(name: string): "image" | "pdf" | null {
  if (/\.pdf$/i.test(name)) return "pdf";
  return /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : null;
}
export function checkedVisualPreview(file: VerifiedFile, value: VisualPreview) {
  if (
    !value ||
    !value.file ||
    ![
      "root",
      "path",
      "resolvedPath",
      "name",
      "size",
      "sha256",
      "version",
    ].every(
      (key) =>
        value.file[key as keyof VerifiedFile] ===
        file[key as keyof VerifiedFile],
    )
  )
    throw new Error(VISUAL_PREVIEW_STRINGS.changed);
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_VISUAL_BYTES ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(MAX_VISUAL_BYTES / 3) * 4
  )
    throw new Error(VISUAL_PREVIEW_STRINGS.limit);
  let bytes: Uint8Array;
  try {
    const raw = atob(value.data);
    if (raw.length !== file.size) throw new Error();
    bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch {
    throw new Error(VISUAL_PREVIEW_STRINGS.failed);
  }
  if (value.mimeType === "application/pdf") {
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-")
      throw new Error(VISUAL_PREVIEW_STRINGS.failed);
    return { kind: "pdf" as const, bytes, mimeType: value.mimeType };
  }
  try {
    const image = inspectImageBytes(bytes);
    if (image.mimeType !== value.mimeType) throw new Error();
    return { kind: "image" as const, bytes, mimeType: image.mimeType };
  } catch {
    throw new Error(VISUAL_PREVIEW_STRINGS.failed);
  }
}
