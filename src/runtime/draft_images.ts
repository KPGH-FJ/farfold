import { invoke } from "@tauri-apps/api/core";
import {
  IMAGE_BYTES_STRINGS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  inspectImageBytes,
  sniffImageMime,
  type ImageMime,
} from "./image_bytes";
import { FILE_DELIVERY_STRINGS as F } from "./file_delivery_strings";
import { DRAFT_STRINGS } from "./draft_storage";
import type { DraftAttachment } from "./drafts";

export const IMAGE_INPUT_STRINGS = {
  invalid: "图片无法读取，请重新选择或移除",
  changed: "图片内容已变化，请重新选择",
  decodeUnavailable: "当前无法检查图片，请稍后重新添加",
  decodeWaitExpired: "图片检查尚未返回，请重新添加或移除这张图片",
  decodeBusy: "已有图片检查尚未结束，请稍后重试",
  linkOnly: "这个 Agent 未提供图片输入，所选图片已作为文件位置添加。",
  noImageInput: "这个 Agent 未提供图片输入，请选择支持图片的 Agent。",
} as const;

export interface DraftImage {
  data: string;
  mimeType: ImageMime;
}
export interface ImageCandidate {
  mimeType: ImageMime;
  data: string | null;
}

const imageMimes: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
let decoding = 0;
export function isBitmapMime(value: string | undefined): value is ImageMime {
  return !!value && imageMimes.includes(value);
}

/** Retained but refused/recovered bytes must never reach a DOM img decoder. */
export function draftImagePreview(attachment: DraftAttachment): string | null {
  const checked = attachment.imageChecked;
  if (
    attachment.kind !== "image" ||
    attachment.loading ||
    attachment.recovered ||
    !checked ||
    checked.data !== attachment.data ||
    checked.mimeType !== attachment.mimeType ||
    checked.uri !== attachment.uri ||
    !isBitmapMime(checked.mimeType)
  )
    return null;
  return `data:${checked.mimeType};base64,${checked.data}`;
}

/** Display only this feature's fixed local errors, never arbitrary IPC text. */
export function imageInputError(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  const allowed: readonly string[] = [
    ...Object.values(IMAGE_INPUT_STRINGS),
    ...Object.values(IMAGE_BYTES_STRINGS),
    DRAFT_STRINGS.attachmentFailed,
    DRAFT_STRINGS.attachmentIncomplete,
    F.checkWaitExpired,
    F.checkBusy,
  ];
  return typeof message === "string" && allowed.includes(message)
    ? message
    : IMAGE_INPUT_STRINGS.invalid;
}

function checkImageDataLength(data: string): void {
  if (typeof data !== "string" || !data)
    throw new Error(DRAFT_STRINGS.attachmentIncomplete);
  if (data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3))
    throw new Error(IMAGE_BYTES_STRINGS.tooLarge);
}

function bytesFromBase64(data: string): Uint8Array {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new Error(IMAGE_INPUT_STRINGS.invalid);
  let decoded: string;
  try {
    decoded = atob(data);
  } catch {
    throw new Error(IMAGE_INPUT_STRINGS.invalid);
  }
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

/** Only bounded static bitmap bytes reach the browser's real decoder. */
export async function validateDraftImage(
  data: string,
  mimeType?: string,
): Promise<DraftImage> {
  // Keep the constant-time input bound ahead of the capacity check. An already
  // full decoder pool must not expand or scan another bounded payload first.
  checkImageDataLength(data);
  if (decoding >= 2) throw new Error(IMAGE_INPUT_STRINGS.decodeBusy);
  const inspection = inspectImageBytes(bytesFromBase64(data));
  if (mimeType !== undefined && mimeType !== inspection.mimeType)
    throw new Error(IMAGE_INPUT_STRINGS.invalid);
  if (typeof Image !== "function")
    throw new Error(IMAGE_INPUT_STRINGS.decodeUnavailable);
  decoding++;
  let image: HTMLImageElement | undefined;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    image = new Image();
    image.src = `data:${inspection.mimeType};base64,${data}`;
    const pending = Promise.resolve().then(() => image!.decode());
    started = true;
    // Timeout only ends the caller's wait. A decoder that has not settled
    // keeps its slot until the real promise returns, even after src is reset.
    void pending.then(
      () => {
        decoding--;
      },
      () => {
        decoding--;
      },
    );
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(IMAGE_INPUT_STRINGS.decodeWaitExpired)),
        15_000,
      );
      pending.then(resolve, () =>
        reject(new Error(IMAGE_INPUT_STRINGS.invalid)),
      );
    });
    const width = image.naturalWidth,
      height = image.naturalHeight;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1
    )
      throw new Error(IMAGE_INPUT_STRINGS.invalid);
    if (
      width > MAX_IMAGE_EDGE ||
      height > MAX_IMAGE_EDGE ||
      width * height > MAX_IMAGE_PIXELS
    )
      throw new Error(IMAGE_BYTES_STRINGS.tooManyPixels);
    return { data, mimeType: inspection.mimeType };
  } finally {
    if (!started) decoding--;
    if (timer !== undefined) clearTimeout(timer);
    // Changing src releases this element's request. A timeout alone is not
    // evidence that all browser decoder work has already stopped.
    if (image) image.src = "";
  }
}

export async function selectedImageCandidate(
  uri: string,
  read: boolean,
): Promise<ImageCandidate | null> {
  let candidate: unknown;
  try {
    candidate = await invoke("draft_attachment_image", { uri, read });
  } catch (error) {
    throw new Error(imageInputError(error));
  }
  if (candidate === null) return null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw new Error(IMAGE_INPUT_STRINGS.invalid);
  const value = candidate as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== "mimeType" && key !== "data") ||
    !isBitmapMime(
      typeof value.mimeType === "string" ? value.mimeType : undefined,
    ) ||
    (value.data !== null && typeof value.data !== "string") ||
    (!read && value.data !== null)
  )
    throw new Error(IMAGE_INPUT_STRINGS.invalid);
  return {
    mimeType: value.mimeType as ImageMime,
    data: value.data as string | null,
  };
}

export async function readFileImage(uri: string): Promise<DraftImage> {
  const candidate = await selectedImageCandidate(uri, true);
  if (!candidate) throw new Error(IMAGE_INPUT_STRINGS.changed);
  if (!candidate.data) throw new Error(DRAFT_STRINGS.attachmentIncomplete);
  return validateDraftImage(candidate.data, candidate.mimeType);
}

export async function clipboardImageCandidate(
  file: File,
): Promise<{ data: string; mimeType?: ImageMime }> {
  if (!Number.isSafeInteger(file.size) || file.size < 1)
    throw new Error(IMAGE_INPUT_STRINGS.invalid);
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error(IMAGE_BYTES_STRINGS.tooLarge);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error(IMAGE_BYTES_STRINGS.tooLarge);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 32_768)
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 32_768)));
  // Keep bounded user input even if validation subsequently refuses it. It
  // never reaches decode or an Agent until the same bytes pass all checks.
  return {
    data: btoa(chunks.join("")),
    mimeType: sniffImageMime(bytes) ?? undefined,
  };
}
