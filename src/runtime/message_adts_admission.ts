import {
  MAX_MESSAGE_AUDIO_RECORDS,
  MAX_MESSAGE_AUDIO_SECONDS,
} from "./message_audio_admission";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

export type MessageAdtsAdmission =
  | "notAdts"
  | "withinBudget"
  | "notCovered"
  | "invalid"
  | "audioTooLong"
  | "audioTooComplex";

const SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000,
  12_000, 11_025, 8_000, 7_350,
] as const;
// LCM of every standard rate: sums stay exact, including mixed-rate headers.
// Even65536 four-block frames at7350Hz stay below2^53 ticks.
const TIMEBASE = 28_224_000;

function hasSync(reader: MessageRasterReader, at: number): boolean {
  return (
    at + 2 <= reader.length &&
    reader.u8(at) === 0xff &&
    (reader.u8(at + 1) & 0xf6) === 0xf0
  );
}

/** Bare ADTS AAC-LC header declarations only. Canonical Base64 and byte
 * admission must precede this call. FFmpeg8.1's official adts_header parser
 * supplies frame_length, standard rate and1024*(raw_blocks+1) samples:
 * https://ffmpeg.org/doxygen/8.1/adts__header_8c_source.html
 *
 * Unknown profiles/rates and CRC-protected layouts remain notCovered; known
 * LC/rate segments still receive the duration budget. Encoded payloads and
 * CRC values are not read, so withinBudget is no codec-conformance guarantee.
 * SBR/PS, gapless trimming, actual playback, loops and decoder allocation are
 * outside this declared sample sum. ID3/ADIF/container prefixes are not
 * searched for a later sync. Interleaved/trailing tags leave the rest unknown.
 */
export function messageAdtsAdmission(data: string): MessageAdtsAdmission {
  const reader = new MessageRasterReader(data);
  if (!hasSync(reader, 0)) return "notAdts";
  try {
    let at = 0;
    let records = 0;
    let ticks = 0;
    let uncovered = false;
    while (at < reader.length) {
      if (++records > MAX_MESSAGE_AUDIO_RECORDS) return "audioTooComplex";
      // Tags have their own framing. Do not guess their extent or scan their
      // payload for sync words, and do not certify the unvisited remainder.
      if (
        reader.matches(at, "ID3") ||
        reader.matches(at, "TAG") ||
        reader.matches(at, "ADIF")
      )
        return "notCovered";
      reader.require(at, 7);
      if (!hasSync(reader, at)) return "invalid";
      const flags = reader.u8(at + 1);
      const format = reader.u8(at + 2);
      const profile = format >>> 6;
      const rate = SAMPLE_RATES[(format >>> 2) & 15];
      const length =
        (reader.u8(at + 3) & 3) * 2048 +
        reader.u8(at + 4) * 8 +
        (reader.u8(at + 5) >>> 5);
      const blocks = (reader.u8(at + 6) & 3) + 1;
      const crc = !(flags & 1);
      if (length < (crc ? 9 : 7)) return "invalid";
      reader.require(at, length);
      if (profile === 1 && rate) {
        ticks += blocks * 1024 * (TIMEBASE / rate);
        if (ticks > MAX_MESSAGE_AUDIO_SECONDS * TIMEBASE) return "audioTooLong";
      } else uncovered = true;
      if (crc) uncovered = true;
      at += length;
    }
    return uncovered ? "notCovered" : "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
