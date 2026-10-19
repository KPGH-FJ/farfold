import type { Attachment, ThreadItem } from "./session_types";
import { MESSAGE_ATTACHMENTS } from "./message_attachment_strings";
import { messagePngAdmission } from "./message_png_admission";
import { messageRasterAdmission } from "./message_raster_admission";
import { messageAudioAdmission } from "./message_audio_admission";
import { messageAvifAdmission } from "./message_avif_admission";
import { messageFlacAdmission } from "./message_flac_admission";
import { messageAdtsAdmission } from "./message_adts_admission";
import { messageMpegAudioAdmission } from "./message_mpeg_audio_admission";
import { messageMp4AudioAdmission } from "./message_mp4_audio_admission";
import { messageOggAudioAdmission } from "./message_ogg_audio_admission";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
/** Preserve payload bytes without scanning them before preview admission. */
function payload(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/** Accept only declared message content types with their required payload.
 * Unknown envelopes remain raw and never qualify as readable conversation. */
export function normalizeMessageAttachment(
  content: unknown,
): Attachment | null {
  const c = record(content);
  if (!c) return null;
  if (c.type === "image" || c.type === "audio") {
    const data = payload(c.data);
    const mimeType = nonempty(c.mimeType);
    if (!data || !mimeType) return null;
    return {
      kind: c.type,
      name:
        c.type === "image"
          ? MESSAGE_ATTACHMENTS.kindNames.image
          : MESSAGE_ATTACHMENTS.kindNames.audio,
      data,
      mimeType,
      uri: nonempty(c.uri),
    };
  }
  if (c.type === "resource_link") {
    const uri = nonempty(c.uri);
    const name = nonempty(c.name);
    return uri && name
      ? { kind: "resource_link", name, uri, mimeType: nonempty(c.mimeType) }
      : null;
  }
  if (c.type === "resource") {
    const resource = record(c.resource);
    const uri = nonempty(resource?.uri);
    if (
      !resource ||
      !uri ||
      (typeof resource.text !== "string" && !payload(resource.blob))
    )
      return null;
    return {
      kind: "resource",
      name: uri.split("/").filter(Boolean).at(-1) ?? uri,
      uri,
      mimeType: nonempty(resource.mimeType),
      text: typeof resource.text === "string" ? resource.text : undefined,
      data: payload(resource.blob),
    };
  }
  return null;
}

export function normalizeMessageAttachments(
  content: readonly unknown[],
): Attachment[] {
  return content
    .map(normalizeMessageAttachment)
    .filter((attachment): attachment is Attachment => attachment !== null);
}

/** Match only official declared content. Local approval metadata cannot come
 * from an echoed notification and must not make an exact echo a new message. */
export function sameOfficialAttachment(a: Attachment, b: Attachment): boolean {
  const { localDocumentText: _localA, localAudio: _audioA, ...officialA } = a;
  const { localDocumentText: _localB, localAudio: _audioB, ...officialB } = b;
  if (a.kind === "audio" && b.kind === "audio") {
    const { uri: _uriA, ...audioA } = officialA;
    const { uri: _uriB, ...audioB } = officialB;
    return JSON.stringify(audioA) === JSON.stringify(audioB);
  }
  return JSON.stringify(officialA) === JSON.stringify(officialB);
}

export function hasReadableMessages(items: readonly ThreadItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === "user" || item.kind === "agent") &&
      (item.text.trim().length > 0 ||
        (item.attachments ?? []).some(
          (attachment) =>
            !!attachment.name.trim() &&
            !!(attachment.uri || attachment.data || attachment.text),
        )),
  );
}

export const MAX_MESSAGE_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_MEDIA_LENGTH = 4 * Math.ceil(MAX_MESSAGE_MEDIA_BYTES / 3);
type MessageMedia = { kind: "image" | "audio"; src: string };
export type MessageMediaAdmission =
  | { status: "available"; media: MessageMedia }
  | { status: "unavailable" }
  | {
      status: "rejected";
      reason:
        | "tooLarge"
        | "invalid"
        | "tooManyPixels"
        | "tooComplex"
        | "audioTooLong"
        | "audioTooComplex";
    };

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

export type MessageMediaPreviewEligibility =
  | Exclude<MessageMediaAdmission, { status: "available" }>
  | {
      status: "eligible";
      data: string;
      mime: string;
      kind: "image" | "audio";
      bytes: number;
      padding: number;
    };

/** Cheap preview reservation only: no alphabet/codec scan and no source URL.
 * Eligibility is not a format admission; the original payload stays unchanged. */
export function attachmentMediaPreviewEligibility(
  attachment: Attachment,
): MessageMediaPreviewEligibility {
  const data = attachment.data;
  if (typeof data !== "string") return { status: "unavailable" };
  const overEncodedLimit = data.length > MAX_ENCODED_MEDIA_LENGTH;
  const mime = attachment.mimeType?.toLowerCase();
  const kind =
    mime && /^image\/(?:png|apng|jpeg|gif|webp|avif|bmp)$/.test(mime)
      ? "image"
      : mime &&
          /^audio\/(?:mpeg|mp3|mp4|ogg|wav|wave|x-wav|webm|flac|aac)$/.test(
            mime,
          )
        ? "audio"
        : null;
  if (!kind) return { status: "unavailable" };
  if (overEncodedLimit) return { status: "rejected", reason: "tooLarge" };
  if (!data.length || data.length % 4 !== 0)
    return { status: "rejected", reason: "invalid" };
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = (data.length / 4) * 3 - padding;
  if (decodedBytes > MAX_MESSAGE_MEDIA_BYTES)
    return { status: "rejected", reason: "tooLarge" };
  return {
    status: "eligible",
    data,
    mime: mime!,
    kind,
    bytes: decodedBytes,
    padding,
  };
}

/** Preview-only byte and declared image/audio metadata admission. Original payload,
 * transport and actual decoder memory are not bounded here. Recognized linear
 * WAVE, native FLAC, ADTS and indexed LayerIII MPEG frames receive their
 * recognized duration policies, including selected leading ID3 stored extents
 * on the ADTS/MPEG paths. Selected classic MP4 audio-track declarations also
 * receive a media-clock policy. Selected continuous Ogg Vorbis declarations
 * also receive a known audio-interval lower-bound policy. The original source is never rewritten;
 * other audio and unknown duration declarations remain uncovered.
 * PNG/APNG receives only structural/declaration admission,
 * including animation frame work; actual playback remains unverified.
 * No URL is created before the checks.
 * Remote links are never fetched. No payload trim, decode or URL precedes the
 * constant-time length gate; the admitted alphabet scan has no regex backtracking. */
export function attachmentMediaAdmission(
  attachment: Attachment,
): MessageMediaAdmission {
  const eligibility = attachmentMediaPreviewEligibility(attachment);
  if (eligibility.status !== "eligible") return eligibility;
  const { data, mime, kind, padding } = eligibility;
  const bodyLength = data.length - padding;
  let tail = -1;
  for (let index = 0; index < bodyLength; index++) {
    tail = base64Value(data.charCodeAt(index));
    if (tail < 0) return { status: "rejected", reason: "invalid" };
  }
  // Padding belongs only to the final quartet. Its unused bits must be zero.
  if ((padding === 2 && tail % 16 !== 0) || (padding === 1 && tail % 4 !== 0))
    return { status: "rejected", reason: "invalid" };
  if (kind === "image") {
    const png = messagePngAdmission(
      data,
      mime === "image/png" || mime === "image/apng",
    );
    if (png !== "withinBudget" && png !== "notPng")
      return { status: "rejected", reason: png };
    if (png === "notPng") {
      // Identify AVIF before a declared JPEG/GIF/etc. mismatch can short-circuit
      // its known declarations. Keep actual raster signatures under image/avif
      // on their existing path, and preserve uncovered AVIF variants.
      const avif = messageAvifAdmission(data, false);
      if (
        avif !== "withinBudget" &&
        avif !== "notCovered" &&
        avif !== "notAvif"
      )
        return { status: "rejected", reason: avif };
      if (avif === "notAvif") {
        const raster = messageRasterAdmission(data, mime!);
        if (raster !== "withinBudget" && raster !== "notCovered")
          return { status: "rejected", reason: raster };
        if (raster === "notCovered" && mime === "image/avif")
          return { status: "rejected", reason: "invalid" };
      }
    }
  } else {
    const audio = messageAudioAdmission(data, mime!);
    if (audio !== "withinBudget" && audio !== "notCovered")
      return { status: "rejected", reason: audio };
    if (audio === "notCovered") {
      // Inspect actual signatures across the already allowed audio MIME types.
      // A different declared MIME must not bypass a known FLAC duration limit.
      const flac = messageFlacAdmission(data);
      if (
        flac !== "withinBudget" &&
        flac !== "notCovered" &&
        flac !== "notFlac"
      )
        return { status: "rejected", reason: flac };
      if (flac === "notFlac") {
        const adts = messageAdtsAdmission(data);
        if (
          adts !== "withinBudget" &&
          adts !== "notCovered" &&
          adts !== "notAdts"
        )
          return { status: "rejected", reason: adts };
        if (adts === "notAdts") {
          const mpeg = messageMpegAudioAdmission(data);
          if (
            mpeg !== "withinBudget" &&
            mpeg !== "notCovered" &&
            mpeg !== "notMpegAudio"
          )
            return { status: "rejected", reason: mpeg };
          if (mpeg === "notMpegAudio") {
            const mp4 = messageMp4AudioAdmission(data);
            if (
              mp4 !== "withinBudget" &&
              mp4 !== "notCovered" &&
              mp4 !== "notMp4Audio"
            )
              return { status: "rejected", reason: mp4 };
            if (mp4 === "notMp4Audio") {
              const ogg = messageOggAudioAdmission(data);
              if (ogg !== "notCovered" && ogg !== "notOggAudio")
                return { status: "rejected", reason: ogg };
            }
          }
        }
      }
    }
  }
  return {
    status: "available",
    media: { kind, src: `data:${mime};base64,${data}` },
  };
}

/** Compatibility for consumers that only need an admitted preview source. */
export function attachmentMedia(attachment: Attachment): MessageMedia | null {
  const result = attachmentMediaAdmission(attachment);
  return result.status === "available" ? result.media : null;
}
