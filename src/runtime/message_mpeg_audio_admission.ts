import {
  MAX_MESSAGE_AUDIO_RECORDS,
  MAX_MESSAGE_AUDIO_SECONDS,
} from "./message_audio_admission";
import { messageAudioPrefix } from "./message_audio_prefix";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

export type MessageMpegAudioAdmission =
  | "notMpegAudio"
  | "withinBudget"
  | "notCovered"
  | "invalid"
  | "audioTooLong"
  | "audioTooComplex";

const RATES = [44_100, 48_000, 32_000] as const;
const BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
] as const;
// LCM of all9 indexed MPEG1/2/2.5 rates. Even65536 known frames have exact
// integer ticks below2^53; channel count never multiplies elapsed sample time.
const TIMEBASE = 14_112_000;

function layer3Sync(reader: MessageRasterReader, at: number): boolean {
  return (
    at + 2 <= reader.length &&
    reader.u8(at) === 255 &&
    (reader.u8(at + 1) & 0xe6) === 0xe2
  );
}

/** Indexed-bitrate LayerIII frame declarations after supported leading ID3
 * stored extents only. Canonical Base64
 * and byte admission must precede this call. Official FFmpeg8.1 header code
 * defines indexed rates/bitrates, length/padding and1152/576 samples:
 * https://ffmpeg.org/doxygen/8.1/mpegaudiodecheader_8c_source.html
 * https://ffmpeg.org/doxygen/8.1/mpegaudiotabs_8h_source.html
 *
 * Unknown ID3/container prefixes are not searched for sync. Free format has no known
 * next extent here; opaque tails/layer changes stay notCovered. CRC-protected
 * frames stay partial while their independent known duration is still checked.
 * No CRC, side-info/bit-reservoir or encoded audio is decoded/validated. Xing,
 * VBRI and gapless tags never replace actual visited frame sums. This is not
 * actual playback duration, full MP3 support or decoder/transport memory proof.
 */
export function messageMpegAudioAdmission(
  data: string,
): MessageMpegAudioAdmission {
  const reader = new MessageRasterReader(data);
  const prefix = messageAudioPrefix(reader);
  if (prefix.status !== "none" && prefix.status !== "supported")
    return prefix.status;
  if (!layer3Sync(reader, prefix.offset)) return "notMpegAudio";
  try {
    let at = prefix.offset;
    let records = prefix.records;
    let ticks = 0;
    let uncovered = false;
    while (at < reader.length) {
      // Unframed/tagged tails have no known extent. Never search their bytes
      // for a guessed next header or claim the unvisited remainder is covered.
      if (!layer3Sync(reader, at)) return "notCovered";
      if (++records > MAX_MESSAGE_AUDIO_RECORDS) return "audioTooComplex";
      reader.require(at, 4);
      const flags = reader.u8(at + 1);
      const version = (flags >>> 3) & 3;
      const format = reader.u8(at + 2);
      const bitrateIndex = format >>> 4;
      const rateIndex = (format >>> 2) & 3;
      if (version === 1 || rateIndex === 3 || bitrateIndex === 15)
        return "invalid";
      if (bitrateIndex === 0) return "notCovered"; // Free-format extent unknown.
      const lsf = version !== 3;
      const rate =
        RATES[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      const bitrate = BITRATES[lsf ? 1 : 0][bitrateIndex];
      const length =
        Math.floor((bitrate * 144_000) / (rate * (lsf ? 2 : 1))) +
        ((format >>> 1) & 1);
      reader.require(at, length);
      ticks += (lsf ? 576 : 1152) * (TIMEBASE / rate);
      if (ticks > MAX_MESSAGE_AUDIO_SECONDS * TIMEBASE) return "audioTooLong";
      if (!(flags & 1)) uncovered = true;
      at += length;
    }
    return uncovered ? "notCovered" : "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
