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

interface StoredFrameFormat {
  align: number;
  sampleRate: number;
}

/** Known PCM/float and byte-per-channel G.711 stored-frame layouts only.
 * G.711's one encoded octet per sample permits the same stored-frame count;
 * other compressed formats never inherit this byte/sample relationship. */
function storedFrameFormat(
  reader: MessageRasterReader,
  at: number,
  length: number,
): StoredFrameFormat | null {
  // The original WAVE common fields are 14 bytes. Bits/extension fields are
  // format-specific; do not demand a PCM layout of an unknown format.
  requireAudio(length >= 14);
  let tag = reader.u16le(at);
  if (tag === 6 || tag === 7) {
    // Selected ordinary WAVEFORMATEX A-law/mu-law with no extra fields.
    // Unknown extension layouts stay compatible and uncovered. RFC3551
    // section4.5.14 specifies eight encoded bits per G.711 sample;
    // RFC2361 A.7/A.8 identifies the WAVE tags. No PCM is decoded here.
    if (length !== 18 || reader.u16le(at + 16) !== 0) return null;
    const channels = reader.u16le(at + 2);
    const sampleRate = reader.u32le(at + 4);
    const align = reader.u16le(at + 12);
    requireAudio(channels > 0 && sampleRate > 0 && reader.u16le(at + 14) === 8);
    requireAudio(align === channels);
    requireAudio(reader.u32le(at + 8) === sampleRate * align);
    return { align, sampleRate };
  }
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
 * decoder is created. RIFX/RF64/Wave64, other compressed WAVE, wavl, playlist timing
 * and other containers remain uncovered. A playlist cannot hide a known
 * recognized stored-data extent; its stored frames retain the independent budget.
 * Duration is recognized stored data frames, not elapsed playback, loop duration,
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
    let format: StoredFrameFormat | null = null;
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
        format = storedFrameFormat(reader, start, length);
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
    if (!format || dataBytes === null) return "notCovered";
    requireAudio(dataBytes % format.align === 0);
    const frames = dataBytes / format.align;
    if (frames > format.sampleRate * MAX_MESSAGE_AUDIO_SECONDS)
      return "audioTooLong";
    return extendedLayout ? "notCovered" : "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
