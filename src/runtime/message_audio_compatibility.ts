import { invoke } from "@tauri-apps/api/core";
import {
  attachmentMediaAdmission,
  MAX_MESSAGE_MEDIA_BYTES,
} from "./message_attachments";
import { messageMediaBudget } from "./message_media_budget";
import { MESSAGE_ATTACHMENTS as S } from "./message_attachment_strings";
import { MessageRasterReader } from "./message_raster_reader";

export interface CompatibleAudio {
  src: string;
  dispose(): void;
}

function bytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}

function hasCompatibleAudioPrefix(data: string): boolean {
  const reader = new MessageRasterReader(data);
  // Match the native decoder's input check. The platform check and actual
  // decoding still determine whether the admitted source can play.
  return (
    reader.matches(0, "fLaC") ||
    (reader.length >= 7 &&
      reader.u8(0) === 0xff &&
      (reader.u8(1) & 0xf6) === 0xf0)
  );
}

/** The caller supplies a data URL from successful attachment admission. */
export function canOfferAudioCompatibility(source: string): boolean {
  const comma = source.indexOf(",");
  return comma >= 0 && hasCompatibleAudioPrefix(source.slice(comma + 1));
}

/** Check the complete returned WAVE, not just fields from an IPC response. */
function checkedWave(
  value: unknown,
  sourceHash: string,
): Uint8Array<ArrayBuffer> {
  if (!value || typeof value !== "object")
    throw Error(S.audioCompatibilityFailed);
  const item = value as Record<string, unknown>;
  const { data, sampleRate, channels, frames, sourceSha256 } = item;
  if (
    typeof data !== "string" ||
    sourceSha256 !== sourceHash ||
    !Number.isSafeInteger(sampleRate) ||
    (sampleRate as number) < 8000 ||
    (sampleRate as number) > 96000 ||
    (channels !== 1 && channels !== 2) ||
    !Number.isSafeInteger(frames) ||
    (frames as number) <= 0 ||
    (frames as number) > (sampleRate as number) * 600 ||
    attachmentMediaAdmission({ name: "", mimeType: "audio/wav", data })
      .status !== "available"
  )
    throw Error(S.audioCompatibilityFailed);
  const result = bytes(data);
  const view = new DataView(result.buffer);
  const rate = sampleRate as number;
  if (
    result.length !== 44 + (frames as number) * channels * 4 ||
    result.length > MAX_MESSAGE_MEDIA_BYTES ||
    view.getUint32(0, false) !== 0x52494646 ||
    view.getUint32(4, true) !== result.length - 8 ||
    view.getUint32(8, false) !== 0x57415645 ||
    view.getUint32(12, false) !== 0x666d7420 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 3 ||
    view.getUint16(22, true) !== channels ||
    view.getUint32(24, true) !== rate ||
    view.getUint32(28, true) !== rate * channels * 4 ||
    view.getUint16(32, true) !== channels * 4 ||
    view.getUint16(34, true) !== 32 ||
    view.getUint32(36, false) !== 0x64617461 ||
    view.getUint32(40, true) !== result.length - 44
  )
    throw Error(S.audioCompatibilityFailed);
  for (let at = 44; at < result.length; at += 4) {
    if (!Number.isFinite(view.getFloat32(at, true)))
      throw Error(S.audioCompatibilityFailed);
  }
  return result;
}

export async function audioCompatibilityAvailable(): Promise<boolean> {
  return (await invoke<unknown>("audio_preview_available")) === true;
}

/** Only an explicit compatibility request calls this. Abort retires display
 * intent, not the system decoder. Its full reservation stays until settlement. */
export async function prepareCompatibleAudio(
  source: string,
  signal: AbortSignal,
): Promise<CompatibleAudio | null> {
  if (signal.aborted) return null;
  // The original preview has already retired. Reserve the entire possible
  // result before expanding input or calling the native decoder. It uses the
  // same four-instance / 32 MiB pool as every other message preview.
  const lease = messageMediaBudget.acquire(MAX_MESSAGE_MEDIA_BYTES);
  if (!lease) throw Error(S.mediaBudgetReached);
  let transferred = false;
  try {
    const comma = source.indexOf(",");
    if (
      comma < 0 ||
      !/^data:audio\/[a-z0-9-]+;base64$/.test(source.slice(0, comma))
    )
      throw Error(S.audioCompatibilityFailed);
    const data = source.slice(comma + 1);
    const mimeType = source.slice(5, comma - 7);
    if (
      attachmentMediaAdmission({ name: "", mimeType, data }).status !==
        "available" ||
      !hasCompatibleAudioPrefix(data)
    )
      throw Error(S.audioCompatibilityFailed);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(data))),
    )
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (signal.aborted) return null;
    const response = await invoke<unknown>("audio_preview_decode", { data });
    if (signal.aborted) return null;
    const wave = checkedWave(response, hash);
    const src = URL.createObjectURL(new Blob([wave], { type: "audio/wav" }));
    let live = true;
    const dispose = () => {
      if (!live) return;
      live = false;
      URL.revokeObjectURL(src);
      lease.release();
    };
    transferred = true;
    return { src, dispose };
  } catch (error) {
    if (signal.aborted) return null;
    if (error === "busy") throw Error(S.audioCompatibilityBusy);
    if (error === "limit") throw Error(S.audioCompatibilityLimit);
    if (error === "unsupportedPlatform")
      throw Error(S.audioCompatibilityUnavailable);
    if (
      error instanceof Error &&
      [S.mediaBudgetReached, S.audioCompatibilityFailed].includes(
        error.message as typeof S.mediaBudgetReached,
      )
    )
      throw error;
    throw Error(S.audioCompatibilityFailed);
  } finally {
    if (!transferred) lease.release();
  }
}
