import {
  MAX_MESSAGE_AUDIO_RECORDS,
  MAX_MESSAGE_AUDIO_SECONDS,
} from "./message_audio_admission";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

interface ConstantFrameFormat {
  rate: number;
  channels: number;
  bits: number;
  blockSize: number;
}

const CODED_MINIMUM = [0, 0, 128, 2048, 65_536, 2_097_152, 67_108_864];
const DEPTHS = [0, 8, 12, 0, 16, 20, 24, 32];
const RATES = [
  0, 88_200, 176_400, 192_000, 8000, 16_000, 22_050, 24_000, 32_000, 44_100,
  48_000, 96_000,
];

function requireFrame(value: unknown): asserts value {
  if (!value) throw new MessageRasterError("invalid");
}

function crc(
  reader: MessageRasterReader,
  start: number,
  end: number,
  bits: 8 | 16,
  polynomial: number,
): number {
  let value = 0;
  const top = 1 << (bits - 1);
  const mask = (1 << bits) - 1;
  for (let at = start; at < end; at++) {
    value ^= reader.u8(at) << (bits - 8);
    for (let bit = 0; bit < 8; bit++)
      value = ((value << 1) ^ (value & top ? polynomial : 0)) & mask;
  }
  return value;
}

/** Integer code, not Unicode text: no general-purpose UTF-8 decoder. */
function frameNumber(reader: MessageRasterReader, at: number) {
  const first = reader.u8(at++);
  if (first < 128) return { value: first, at };
  requireFrame(first >= 0xc2 && first <= 0xfd);
  const length =
    first < 0xe0
      ? 2
      : first < 0xf0
        ? 3
        : first < 0xf8
          ? 4
          : first < 0xfc
            ? 5
            : 6;
  let value = first & ((1 << (7 - length)) - 1);
  for (let index = 1; index < length; index++) {
    const byte = reader.u8(at++);
    requireFrame((byte & 0xc0) === 0x80);
    value = value * 64 + (byte & 0x3f);
  }
  requireFrame(value >= CODED_MINIMUM[length] && value <= 0x7fff_ffff);
  return { value, at };
}

/** Selected stored-frame lower bound, not a FLAC decoder or duration success.
 * Fixed blocking, matching rate, mono16-bit constant subframes without wasted
 * bits only. Every counted frame has both
 * CRCs, a consecutive coded number and a completely known extent. No PCM,
 * sync search, residual parsing, payload rewrite, URL or asynchronous work.
 * Unknown layout stops observation without guessing its frame boundary.
 * RFC9639 §§9.1,9.2.3,9.3: https://www.rfc-editor.org/rfc/rfc9639.html
 */
export function messageFlacFrameLowerBound(
  reader: MessageRasterReader,
  at: number,
  records: number,
  format: ConstantFrameFormat,
): "notCovered" | "audioTooLong" | "audioTooComplex" {
  if (format.bits !== 16 || format.channels !== 1 || !format.blockSize)
    return "notCovered";
  let number = 0;
  let samples = 0;
  while (at < reader.length) {
    if (++records > MAX_MESSAGE_AUDIO_RECORDS) return "audioTooComplex";
    const start = at;
    // Other strategies/properties remain uncovered; never search ahead.
    if (!reader.matches(at, "\xff\xf8")) return "notCovered";
    reader.require(at, 4);
    const sizes = reader.u8(at + 2);
    const properties = reader.u8(at + 3);
    const blockCode = sizes >>> 4;
    const rateCode = sizes & 15;
    const depthCode = (properties >>> 1) & 7;
    const channels = (properties >>> 4) + 1;
    const bits: number = depthCode === 0 ? format.bits : DEPTHS[depthCode];
    if (
      !blockCode ||
      rateCode === 15 ||
      properties & 1 ||
      channels > 8 ||
      channels !== format.channels ||
      bits !== format.bits
    )
      return "notCovered";
    const coded = frameNumber(reader, at + 4);
    at = coded.at;
    let blockSize: number;
    if (blockCode === 6) blockSize = reader.u8(at++) + 1;
    else if (blockCode === 7) {
      blockSize = reader.u16be(at) + 1;
      at += 2;
    } else
      blockSize =
        blockCode === 1
          ? 192
          : blockCode < 6
            ? 144 * 2 ** blockCode
            : 2 ** blockCode;
    if (blockSize > format.blockSize || blockSize > 65_535) return "notCovered";
    let rate = rateCode === 0 ? format.rate : RATES[rateCode];
    if (rateCode === 12) rate = reader.u8(at++) * 1000;
    else if (rateCode === 13 || rateCode === 14) {
      rate = reader.u16be(at) * (rateCode === 14 ? 10 : 1);
      at += 2;
    }
    if (rate !== format.rate) return "notCovered";
    requireFrame(coded.value === number);
    requireFrame(crc(reader, start, at, 8, 0x07) === reader.u8(at));
    at++;
    for (let channel = 0; channel < channels; channel++) {
      if (reader.u8(at++) !== 0) return "notCovered";
      reader.require(at, bits / 8);
      at += bits / 8;
    }
    reader.require(at, 2);
    requireFrame(crc(reader, start, at, 16, 0x8005) === reader.u16be(at));
    at += 2;
    samples += blockSize;
    if (samples > format.rate * MAX_MESSAGE_AUDIO_SECONDS)
      return "audioTooLong";
    // A smaller final block is permitted. Do not infer a next-frame offset
    // after such a block plus unknown trailing layout.
    if (blockSize < format.blockSize && at !== reader.length)
      return "notCovered";
    number++;
  }
  // Even a fully visited selected layout does not certify FLAC compatibility,
  // MD5/PCM, elapsed playback or browser allocation. Preserve unknown status.
  return "notCovered";
}
