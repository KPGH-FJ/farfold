import {
  MAX_MESSAGE_RASTER_RECORDS,
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

// A message-preview policy, using the existing audio-input policy as a
// reference. Not a WAVE format limit, decoder-memory or playback guarantee.
export const MAX_MESSAGE_AUDIO_SECONDS = 600;
export const MAX_MESSAGE_AUDIO_RECORDS = MAX_MESSAGE_RASTER_RECORDS;
export type MessageAudioAdmission =
  | "withinBudget"
  | "notCovered"
  | "invalid"
  | "audioTooLong"
  | "audioTooComplex";

function requireAudio(value: unknown): asserts value {
  if (!value) throw new MessageRasterError("invalid");
}

interface LinearFormat {
  align: number;
  sampleRate: number;
}

/** Only known linear formats permit frames = data bytes / block alignment.
 * Unknown compressed formats never inherit PCM byte-rate/sample assumptions. */
function linearFormat(
  reader: MessageRasterReader,
  at: number,
  length: number,
): LinearFormat | null {
  // The original WAVE common fields are 14 bytes. Bits/extension fields are
  // format-specific; do not demand a PCM layout of an unknown format.
  requireAudio(length >= 14);
  let tag = reader.u16le(at);
  if (tag !== 1 && tag !== 3 && tag !== 0xfffe) return null;
  requireAudio(length >= 16);
  const bits = reader.u16le(at + 14);
  if (tag === 0xfffe) {
    requireAudio(length >= 40);
    const extra = reader.u16le(at + 16);
    requireAudio(extra >= 22 && 18 + extra <= length);
    // Standard KSDATAFORMAT_SUBTYPE_PCM/IEEE_FLOAT GUID, in RIFF byte order.
    const suffix = "\0\0\x10\0\x80\0\0\xaa\0\x38\x9b\x71";
    if (!reader.matches(at + 28, suffix)) return null;
    tag = reader.u32le(at + 24);
    if (tag !== 1 && tag !== 3) return null;
    requireAudio(bits > 0 && bits % 8 === 0);
    requireAudio(reader.u16le(at + 18) <= bits);
  }
  // Other floating-point encodings are not certified or removed by this slice.
  if (tag === 3 && bits !== 32 && bits !== 64) return null;
  const channels = reader.u16le(at + 2);
  const sampleRate = reader.u32le(at + 4);
  const rate = reader.u32le(at + 8);
  const align = reader.u16le(at + 12);
  // Classic PCM can have non-byte precision (e.g. 20 bits in 3-byte slots).
  requireAudio(channels > 0 && sampleRate > 0 && bits > 0);
  requireAudio(align === channels * Math.ceil(bits / 8));
  requireAudio(rate === sampleRate * align);
  return { align, sampleRate };
}

/** Classic little-endian RIFF/WAVE declarations only. Caller must first enforce
 * canonical Base64 and the existing per-file byte limit. Cross-audio-MIME
 * signatures receive the same check. No URL, full binary buffer or audio
 * decoder is created. RIFX/RF64/Wave64, compressed WAVE, wavl, playlist timing
 * and other containers remain uncovered. A playlist cannot hide a known
 * direct linear data extent; its stored frames retain the independent budget.
 * Duration is linear stored data frames, not elapsed playback, loop duration,
 * resampled allocation, compressed expansion or transport-memory proof.
 * Microsoft/IBM RIFF WAVE specification: fmt precedes a single data or wavl.
 */
export function messageAudioAdmission(
  data: string,
  mime: string,
): MessageAudioAdmission {
  if (!mime.toLowerCase().startsWith("audio/")) return "notCovered";
  const reader = new MessageRasterReader(data);
  if (!reader.matches(0, "RIFF") || !reader.matches(8, "WAVE"))
    return "notCovered";
  try {
    requireAudio(reader.u32le(4) + 8 === reader.length);
    let at = 12;
    let records = 0;
    let fmtSeen = false;
    let dataSeen = false;
    let extendedLayout = false;
    let linear: LinearFormat | null = null;
    let dataBytes: number | null = null;
    while (at < reader.length) {
      if (++records > MAX_MESSAGE_AUDIO_RECORDS) return "audioTooComplex";
      reader.require(at, 8);
      const length = reader.u32le(at + 4);
      const start = at + 8;
      const end = start + length;
      // RIFF chunk size excludes the alignment byte, including for odd fmt.
      reader.require(start, length + (length % 2));
      if (reader.matches(at, "fmt ")) {
        requireAudio(!fmtSeen && !dataSeen);
        fmtSeen = true;
        linear = linearFormat(reader, start, length);
      } else if (reader.matches(at, "data")) {
        requireAudio(fmtSeen && !dataSeen);
        dataSeen = true;
        dataBytes = length;
      } else if (
        reader.matches(at, "LIST") &&
        length >= 4 &&
        reader.matches(start, "wavl")
      ) {
        requireAudio(fmtSeen && !dataSeen);
        dataSeen = true;
        extendedLayout = true;
      } else if (reader.matches(at, "plst")) extendedLayout = true;
      at = end + (length % 2);
    }
    requireAudio(fmtSeen && dataSeen);
    if (!linear || dataBytes === null) return "notCovered";
    requireAudio(dataBytes % linear.align === 0);
    const frames = dataBytes / linear.align;
    if (frames > linear.sampleRate * MAX_MESSAGE_AUDIO_SECONDS)
      return "audioTooLong";
    return extendedLayout ? "notCovered" : "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
