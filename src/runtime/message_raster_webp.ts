import {
  MessageRasterReader,
  rasterCanvas,
  rasterFrames,
  rasterRecord,
  rasterRequire,
} from "./message_raster_reader";

interface Dimensions {
  width: number;
  height: number;
}
interface Chunk {
  kind: string;
  data: number;
  length: number;
  end: number;
}

/** RFC 9649 container/bitstream dimension declarations only. Compressed pixels,
 * metadata contents, repeated playback and actual codec allocation are not
 * decoded or estimated by this preflight. */
export function messageWebpAdmission(reader: MessageRasterReader): void {
  reader.require(0, 12);
  rasterRequire(
    reader.matches(0, "RIFF") &&
      reader.matches(8, "WEBP") &&
      reader.u32le(4) + 8 === reader.length &&
      reader.length % 2 === 0,
  );
  let records = 0;
  const chunkAt = (at: number, limit: number): Chunk => {
    rasterRecord(++records);
    rasterRequire(at + 8 <= limit);
    reader.require(at, 8);
    let kind = "";
    for (let index = 0; index < 4; index++) {
      const code = reader.u8(at + index);
      rasterRequire(code >= 0x20 && code <= 0x7e);
      kind += String.fromCharCode(code);
    }
    const length = reader.u32le(at + 4);
    const data = at + 8;
    const end = data + length + (length & 1);
    rasterRequire(end <= limit);
    reader.require(data, length + (length & 1));
    if (length & 1) rasterRequire(reader.u8(data + length) === 0);
    return { kind, data, length, end };
  };
  const dimensions = (width: number, height: number): Dimensions => {
    rasterCanvas(width, height);
    return { width, height };
  };
  const bitstream = ({ kind, data, length }: Chunk): Dimensions => {
    if (kind === "VP8 ") {
      rasterRequire(length >= 11 && reader.matches(data + 3, "\x9d\x01\x2a"));
      const tag = reader.u24le(data);
      rasterRequire(
        !(tag & 1) &&
          ((tag >>> 1) & 7) <= 3 &&
          !!(tag & 16) &&
          tag >>> 5 <= length - 10,
      );
      return dimensions(
        reader.u16le(data + 6) & 0x3fff,
        reader.u16le(data + 8) & 0x3fff,
      );
    }
    rasterRequire(kind === "VP8L" && length >= 6 && reader.u8(data) === 0x2f);
    const header = reader.u32le(data + 1);
    rasterRequire(header >>> 29 === 0);
    return dimensions((header & 0x3fff) + 1, ((header >>> 14) & 0x3fff) + 1);
  };
  const alpha = ({ data, length }: Chunk): void => {
    rasterRequire(length >= 2);
    const flags = reader.u8(data);
    rasterRequire(
      !(flags & 0xc0) && (flags & 3) <= 1 && ((flags >>> 4) & 3) <= 1,
    );
  };
  const sameSize = (left: Dimensions, right: Dimensions): void => {
    rasterRequire(left.width === right.width && left.height === right.height);
  };

  let canvas: Dimensions | undefined;
  let flags = 0;
  let image: Dimensions | undefined;
  let imageKind = "";
  let hasAlpha = false;
  let animation = false;
  let frames = 0;
  const metadata = new Set<string>();
  let at = 12;
  while (at < reader.length) {
    const chunk = chunkAt(at, reader.length);
    const { kind, data, length } = chunk;
    if (kind === "VP8X") {
      rasterRequire(at === 12 && !canvas && length === 10);
      flags = reader.u8(data);
      rasterRequire(!(flags & 0xc1) && reader.u24le(data + 1) === 0);
      canvas = dimensions(
        reader.u24le(data + 4) + 1,
        reader.u24le(data + 7) + 1,
      );
    } else if (kind === "ANIM") {
      rasterRequire(canvas && flags & 2 && !animation && !frames && !image);
      rasterRequire(length === 6);
      animation = true;
    } else if (kind === "ANMF") {
      rasterRequire(canvas && flags & 2 && animation && !image && length >= 16);
      const frame = dimensions(
        reader.u24le(data + 6) + 1,
        reader.u24le(data + 9) + 1,
      );
      rasterRequire(
        reader.u24le(data) * 2 + frame.width <= canvas.width &&
          reader.u24le(data + 3) * 2 + frame.height <= canvas.height &&
          !(reader.u8(data + 15) & 0xfc),
      );
      // Each frame is charged at the complete compositing canvas, regardless
      // of its rectangle, duration, disposal, blend mode or loop count.
      rasterFrames(canvas.width * canvas.height, ++frames);
      let nestedAt = data + 16;
      let frameImage = false;
      let frameAlpha = false;
      while (nestedAt < data + length) {
        const nested = chunkAt(nestedAt, data + length);
        if (nested.kind === "ALPH") {
          rasterRequire(!!(flags & 16) && !frameAlpha && !frameImage);
          alpha(nested);
          frameAlpha = true;
        } else if (nested.kind === "VP8 " || nested.kind === "VP8L") {
          rasterRequire(!frameImage && !(frameAlpha && nested.kind === "VP8L"));
          sameSize(frame, bitstream(nested));
          frameImage = true;
        } else {
          // Only unknown chunks may accompany the frame's image/alpha pair.
          rasterRequire(
            !["VP8X", "ANIM", "ANMF", "ICCP", "EXIF", "XMP "].includes(
              nested.kind,
            ),
          );
        }
        nestedAt = nested.end;
      }
      rasterRequire(frameImage);
    } else if (kind === "VP8 " || kind === "VP8L") {
      rasterRequire(!(flags & 2) && !animation && !frames && !image);
      rasterRequire(!(hasAlpha && kind === "VP8L"));
      image = bitstream(chunk);
      imageKind = kind;
      if (canvas) sameSize(canvas, image);
    } else if (kind === "ALPH") {
      rasterRequire(
        canvas && flags & 16 && !(flags & 2) && !hasAlpha && !image,
      );
      alpha(chunk);
      hasAlpha = true;
    } else if (kind === "ICCP" || kind === "EXIF" || kind === "XMP ") {
      rasterRequire(canvas && length > 0 && !metadata.has(kind));
      if (kind === "ICCP")
        rasterRequire(!animation && !frames && !image && !hasAlpha);
      metadata.add(kind);
    }
    // Unknown chunks remain opaque, length-delimited, padded and counted.
    at = chunk.end;
  }
  if (flags & 2) rasterRequire(animation && frames > 0 && !image && !hasAlpha);
  else {
    rasterRequire(image && !animation && !frames);
    if (imageKind === "VP8 " && canvas)
      rasterRequire(!!(flags & 16) === hasAlpha);
  }
  if (canvas) {
    for (const [bit, kind] of [
      [32, "ICCP"],
      [8, "EXIF"],
      [4, "XMP "],
    ] as const)
      rasterRequire(!!(flags & bit) === metadata.has(kind));
  }
}
