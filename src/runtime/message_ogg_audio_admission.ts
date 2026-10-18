import {
  MAX_MESSAGE_AUDIO_RECORDS,
  MAX_MESSAGE_AUDIO_SECONDS,
} from "./message_audio_admission";
import {
  MessageRasterError,
  MessageRasterReader,
} from "./message_raster_reader";

export type MessageOggAudioAdmission =
  "notOggAudio" | "notCovered" | "invalid" | "audioTooLong" | "audioTooComplex";

interface Packet {
  bytes: number;
  prefix: number[];
}
interface Epoch {
  eligible: boolean;
  ended: boolean;
  nextSequence: number;
  mapping: "vorbis" | "opus" | null;
  headers: number;
  rate: number;
  preSkip: number;
  packet: Packet | null;
  anchor: bigint | null;
  previous: bigint | null;
  excessive: boolean;
}

function epoch(sequence: number, bos: boolean): Epoch {
  return {
    eligible: bos && sequence === 0,
    ended: false,
    nextSequence: sequence,
    mapping: null,
    headers: 0,
    rate: 0,
    preSkip: 0,
    packet: null,
    anchor: null,
    previous: null,
    excessive: false,
  };
}

function breakEpoch(stream: Epoch): void {
  stream.eligible = false;
  stream.anchor = null;
  stream.previous = null;
  stream.excessive = false;
}

function prefixU32(prefix: number[], at: number): number {
  return (
    prefix[at] +
    prefix[at + 1] * 256 +
    prefix[at + 2] * 65_536 +
    prefix[at + 3] * 16_777_216
  );
}

function signature(prefix: number[], name: string): boolean {
  return (
    prefix.length >= name.length &&
    [...name].every((char, index) => prefix[index] === char.charCodeAt(0))
  );
}

function headerCount(stream: Epoch): number {
  return stream.mapping === "opus" ? 2 : 3;
}

function opusHeader(stream: Epoch, packet: Packet): void {
  const prefix = packet.prefix;
  if (stream.headers === 0) {
    // Selected RFC7845 version 1, mapping family 0 only. Other layouts stay
    // partial; input sample rate is informational, never the granule clock.
    if (
      !signature(prefix, "OpusHead") ||
      packet.bytes !== 19 ||
      prefix[8] !== 1 ||
      (prefix[9] !== 1 && prefix[9] !== 2) ||
      prefix[18] !== 0
    ) {
      breakEpoch(stream);
      return;
    }
    stream.mapping = "opus";
    stream.rate = 48_000;
    stream.preSkip = prefix[10] + prefix[11] * 256;
  } else if (!signature(prefix, "OpusTags") || packet.bytes < 16) {
    breakEpoch(stream);
    return;
  }
  // Tags contents and compressed audio remain opaque, as for Vorbis setup.
  stream.headers++;
}

function vorbisHeader(stream: Epoch, packet: Packet): void {
  const prefix = packet.prefix;
  if (
    prefix.length < 7 ||
    prefix[0] !== [1, 3, 5][stream.headers] ||
    prefix
      .slice(1, 7)
      .some((byte, index) => byte !== "vorbis".charCodeAt(index))
  ) {
    breakEpoch(stream);
    return;
  }
  if (stream.headers === 0) {
    if (packet.bytes !== 30) {
      breakEpoch(stream);
      return;
    }
    const small = prefix[28] & 15;
    const large = prefix[28] >>> 4;
    const rate = prefixU32(prefix, 12);
    if (
      prefixU32(prefix, 7) !== 0 ||
      prefix[11] === 0 ||
      rate === 0 ||
      small < 6 ||
      large > 13 ||
      small > large ||
      !(prefix[29] & 1)
    ) {
      breakEpoch(stream);
      return;
    }
    stream.mapping = "vorbis";
    stream.rate = rate;
  } else if (packet.bytes < 8) {
    breakEpoch(stream);
    return;
  }
  // Comment contents, setup codebooks/modes and their framing bits are opaque.
  // The ordered packet signatures establish only this declared mapping slice.
  stream.headers++;
}

/** Selected Ogg Vorbis/Opus declared interval lower bounds, never total duration.
 * Caller first checks canonical Base64 and bytes. RFC3533 lacing and Vorbis I
 * Appendix A.2 associate GP with the last completed audio packet. Subtracting
 * two same-epoch endpoints removes a nonzero origin. Only non-EOS pages start
 * an interval; a nondecreasing EOS endpoint may close one after final trimming.
 * Opus always uses 48kHz. Subtract all preSkip conservatively: an early anchor
 * may still precede its discarded prefix, including with a positive origin.
 *
 * Every non-excess remains notCovered. CRC, setup/codebooks, audio payload,
 * packet durations, exact playback and decoder allocation are not validated.
 * https://xiph.org/vorbis/doc/Vorbis_I_spec.html
 * https://www.rfc-editor.org/rfc/rfc3533.html
 * https://www.rfc-editor.org/rfc/rfc7845.html
 */
export function messageOggAudioAdmission(
  data: string,
): MessageOggAudioAdmission {
  const reader = new MessageRasterReader(data);
  if (!reader.matches(0, "OggS")) return "notOggAudio";
  let records = 0;
  const record = (count = 1) => {
    records += count;
    return records <= MAX_MESSAGE_AUDIO_RECORDS;
  };
  const streams = new Map<number, Epoch>();
  const epochs: Epoch[] = [];
  try {
    let at = 0;
    while (at < reader.length) {
      if (!record()) return "audioTooComplex";
      reader.require(at, 27);
      if (!reader.matches(at, "OggS")) return "invalid";
      // Future page layouts have no guessed next-page offset or resync scan.
      if (reader.u8(at + 4) !== 0) return "notCovered";
      const flags = reader.u8(at + 5);
      const continued = !!(flags & 1);
      const bos = !!(flags & 2);
      const eos = !!(flags & 4);
      const serial = reader.u32le(at + 14);
      const sequence = reader.u32le(at + 18);
      const count = reader.u8(at + 26);
      if (!record(count)) return "audioTooComplex";
      reader.require(at + 27, count);
      let bodyBytes = 0;
      for (let index = 0; index < count; index++)
        bodyBytes += reader.u8(at + 27 + index);
      let body = at + 27 + count;
      reader.require(body, bodyBytes);

      let stream = streams.get(serial);
      if (bos || !stream || stream.ended) {
        if (stream && (!stream.ended || !bos)) breakEpoch(stream);
        stream = epoch(sequence, bos);
        streams.set(serial, stream);
        epochs.push(stream);
      }
      if (
        flags & ~7 ||
        sequence !== stream.nextSequence ||
        continued !== (stream.packet !== null)
      ) {
        breakEpoch(stream);
        stream.packet = null;
      }
      stream.nextSequence = (sequence + 1) >>> 0;
      const headersBeforePage = stream.headers;
      let completedPackets = 0;
      let completedAudio = false;
      for (let index = 0; index < count; index++) {
        const lace = reader.u8(at + 27 + index);
        if (!stream.packet) {
          stream.packet = { bytes: 0, prefix: [] };
          // Both selected mappings end their last header on a prior page.
          if (
            stream.headers === headerCount(stream) &&
            headersBeforePage < headerCount(stream)
          )
            breakEpoch(stream);
        }
        const packet = stream.packet;
        if (stream.eligible) {
          const prefixLimit = stream.headers < headerCount(stream) ? 30 : 1;
          const take = Math.min(lace, prefixLimit - packet.prefix.length);
          if (!record(take)) return "audioTooComplex";
          for (let byte = 0; byte < take; byte++)
            packet.prefix.push(reader.u8(body + byte));
        }
        packet.bytes += lace;
        body += lace;
        if (lace === 255) continue;
        completedPackets++;
        stream.packet = null;
        if (!stream.eligible) continue;
        if (stream.headers < headerCount(stream)) {
          if (stream.mapping === "opus" || signature(packet.prefix, "OpusHead"))
            opusHeader(stream, packet);
          else vorbisHeader(stream, packet);
        } else if (
          packet.bytes > 0 &&
          (stream.mapping === "opus" || !(packet.prefix[0] & 1))
        )
          completedAudio = true;
        else breakEpoch(stream); // Nil/other packets are not known audio endpoints.
      }
      // The identification packet must be complete and alone on its BOS page.
      if (
        headersBeforePage === 0 &&
        stream.headers > 0 &&
        (!bos || completedPackets !== 1 || stream.packet !== null)
      )
        breakEpoch(stream);
      if (stream.eligible && completedAudio) {
        const raw =
          BigInt(reader.u32le(at + 6)) | (BigInt(reader.u32le(at + 10)) << 32n);
        // Signed negatives, including -1 (no completed packet), are not anchors.
        if (
          raw >= 0x8000_0000_0000_0000n ||
          (stream.previous !== null && raw < stream.previous)
        )
          breakEpoch(stream);
        else {
          stream.previous = raw;
          if (stream.anchor !== null) {
            if (
              raw - stream.anchor - BigInt(stream.preSkip) >
              BigInt(stream.rate) * BigInt(MAX_MESSAGE_AUDIO_SECONDS)
            )
              stream.excessive = true;
          } else if (!eos) stream.anchor = raw;
        }
      }
      if (eos) {
        if (stream.packet !== null) breakEpoch(stream);
        stream.ended = true;
      }
      at += 27 + count + bodyBytes;
    }
    // A later ownership/continuation/timing contradiction must not be hidden by
    // an early long interval. Other independent intact epochs remain eligible.
    for (const stream of epochs) if (stream.packet !== null) breakEpoch(stream);
    return epochs.some((stream) => stream.eligible && stream.excessive)
      ? "audioTooLong"
      : "notCovered";
  } catch (error) {
    if (error instanceof MessageRasterError) return "invalid";
    throw error;
  }
}
