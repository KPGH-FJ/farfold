import { MAX_MESSAGE_AUDIO_RECORDS } from "./message_audio_admission";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

export type MessageAudioPrefix =
  | { status: "none" | "supported"; offset: number; records: number }
  | { status: "notCovered" | "invalid" | "audioTooComplex" };

/** Leading ID3v2.2/2.3/2.4 revision0 stored extents only. Their synchsafe size
 * excludes the10-byte header; v2.4's optional matching footer adds10 more.
 * https://id3.org/id3v2-00 section3.1
 * https://id3.org/id3v2.3.0 section3.1
 * https://id3.org/id3v2.4.0-structure sections3.1/3.4
 *
 * No tag body/frame/embedded image/URL, compression, unsynchronisation or CRC
 * is decoded or validated. Stored sizes include unsynchronisation bytes, so
 * defined flags do not require rewriting the media. v2.2 compression and
 * unknown versions/revisions/flags remain uncovered, never a guessed offset.
 * Only consecutive leading tags are visited: no sync search or tail scan.
 * Caller first checks canonical Base64/byte budget; the original source stays
 * intact. These metadata records share the caller's audio frame record cap.
 */
export function messageAudioPrefix(
  reader: MessageRasterReader,
): MessageAudioPrefix {
  let offset = 0;
  let records = 0;
  try {
    while (reader.matches(offset, "ID3")) {
      if (++records > MAX_MESSAGE_AUDIO_RECORDS)
        return { status: "audioTooComplex" };
      reader.require(offset, 5);
      const version = reader.u8(offset + 3);
      const revision = reader.u8(offset + 4);
      if (version === 255 || revision === 255) return { status: "invalid" };
      if (![2, 3, 4].includes(version) || revision !== 0)
        return { status: "notCovered" };
      reader.require(offset, 10);
      const flags = reader.u8(offset + 5);
      const knownFlags = version === 2 ? 0xc0 : version === 3 ? 0xe0 : 0xf0;
      if (flags & ~knownFlags || (version === 2 && flags & 0x40))
        return { status: "notCovered" };
      let size = 0;
      for (let index = 6; index < 10; index++) {
        const byte = reader.u8(offset + index);
        if (byte & 128) return { status: "invalid" };
        size = size * 128 + byte;
      }
      const footer = version === 4 && !!(flags & 0x10);
      reader.require(offset, 10 + size + (footer ? 10 : 0));
      if (footer) {
        const at = offset + 10 + size;
        if (!reader.matches(at, "3DI")) return { status: "invalid" };
        for (let index = 3; index < 10; index++)
          if (reader.u8(at + index) !== reader.u8(offset + index))
            return { status: "invalid" };
      }
      offset += 10 + size + (footer ? 10 : 0);
    }
    return { status: records ? "supported" : "none", offset, records };
  } catch (error) {
    if (error instanceof MessageRasterError) return { status: "invalid" };
    throw error;
  }
}
