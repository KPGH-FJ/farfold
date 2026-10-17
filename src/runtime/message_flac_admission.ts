import {
  MAX_MESSAGE_AUDIO_RECORDS,
  MAX_MESSAGE_AUDIO_SECONDS,
} from "./message_audio_admission";
import { messageAudioPrefix } from "./message_audio_prefix";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

export type MessageFlacAdmission =
  | "notFlac"
  | "withinBudget"
  | "notCovered"
  | "invalid"
  | "audioTooLong"
  | "audioTooComplex";

function requireFlac(value: unknown): asserts value {
  if (!value) throw new MessageRasterError("invalid");
}

/** fLaC metadata declarations after selected leading ID3 stored extents only;
 * canonical Base64 and byte admission
 * must precede this call. RFC9639 §§6,8.1,8.2: STREAMINFO is first and unique;
 * interchannel samples / rate is a declared duration, independent of channels.
 * Zero total samples are unknown; zero rate may describe legal non-audio data.
 * Neither is a zero-duration success. Reserved metadata stays uncovered while
 * independently known budgets still apply. Payloads (including PICTURE/URIs),
 * frame overrides/CRCs, actual playback and decoder memory are not inspected.
 * https://www.rfc-editor.org/rfc/rfc9639.html
 * Leading ID3 is optional decoder compatibility, not a FLAC conformance rule:
 * https://www.xiph.org/flac/documentation_format_overview.html
 * No tag bytes are removed or decoded; prefix and metadata share the record cap.
 */
export function messageFlacAdmission(data: string): MessageFlacAdmission {
  const reader = new MessageRasterReader(data);
  const prefix = messageAudioPrefix(reader);
  if (prefix.status !== "none" && prefix.status !== "supported")
    return prefix.status;
  if (!reader.matches(prefix.offset, "fLaC")) return "notFlac";
  try {
    let at = prefix.offset + 4;
    let records = prefix.records;
    let metadataRecords = 0;
    let rate = 0;
    let samples = 0;
    let uncovered = false;
    let last = false;
    while (!last) {
      if (++records > MAX_MESSAGE_AUDIO_RECORDS) return "audioTooComplex";
      reader.require(at, 4);
      const tag = reader.u8(at);
      const type = tag & 0x7f;
      const length = reader.u8(at + 1) * 65_536 + reader.u16be(at + 2);
      const start = at + 4;
      reader.require(start, length);
      requireFlac(
        type !== 127 && (metadataRecords++ === 0 ? type === 0 : type !== 0),
      );
      if (type === 0) {
        requireFlac(length === 34);
        const minBlock = reader.u16be(start);
        const maxBlock = reader.u16be(start + 2);
        requireFlac(minBlock >= 16 && maxBlock >= minBlock);
        const minFrame =
          reader.u8(start + 4) * 65_536 + reader.u16be(start + 5);
        const maxFrame =
          reader.u8(start + 7) * 65_536 + reader.u16be(start + 8);
        requireFlac(!minFrame || !maxFrame || minFrame <= maxFrame);
        rate = reader.u16be(start + 10) * 16 + (reader.u8(start + 12) >>> 4);
        const bits =
          (reader.u8(start + 12) & 1) * 16 + (reader.u8(start + 13) >>> 4) + 1;
        requireFlac(bits >= 4 && bits <= 32);
        // The high four bits are essential: the field is 36, not32, bits.
        samples =
          (reader.u8(start + 13) & 15) * 4_294_967_296 +
          reader.u32be(start + 14);
      } else if (type >= 7) uncovered = true;
      last = !!(tag & 0x80);
      at = start + length;
    }
    requireFlac(at < reader.length); // At least one frame follows the metadata.
    if (rate && samples > rate * MAX_MESSAGE_AUDIO_SECONDS)
      return "audioTooLong";
    return !rate || !samples || uncovered ? "notCovered" : "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
