import {
  MAX_MESSAGE_RASTER_FRAME_PIXELS,
  MessageRasterError,
  MessageRasterReader,
  rasterCanvas,
  rasterFrames,
  rasterRecord,
  rasterRequire,
} from "./message_raster_reader";

const IHDR = 0x49484452;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const ACTL = 0x6163544c;
const FCTL = 0x6663544c;
const FDAT = 0x66644154;

/** CRC only for fixed-size animation controls. Compressed pixels and opaque
 * ancillary payloads are not scanned, inflated or copied by this preflight. */
function controlCrc(reader: MessageRasterReader, start: number, end: number) {
  let crc = 0xffffffff;
  for (let at = start; at < end; at++) {
    crc ^= reader.u8(at);
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  rasterRequire((crc ^ 0xffffffff) >>> 0 === reader.u32be(end));
}

/** W3C PNG 3 animation declarations, after byte/Base64/IHDR admission. Bounds
 * container traversal, controls and full-canvas frame work; not actual codec
 * memory, compressed data/CRC validity, loop count or playback duration.
 * https://www.w3.org/TR/png-3/#11Anim
 */
export function messageApngAdmission(
  reader: MessageRasterReader,
  width: number,
  height: number,
): void {
  const canvasPixels = width * height;
  let at = 33;
  let records = 1; // The existing CRC-checked IHDR is already admitted.
  let declaredFrames = 0;
  let frames = 0;
  let sequence = 0;
  let imageSeen = false;
  let imageEnded = false;
  let imageBytes = 0;
  let current: "default" | "frame" | null = null;
  let frameBytes = 0;
  while (at < reader.length) {
    rasterRecord(++records);
    reader.require(at, 12);
    const length = reader.u32be(at);
    rasterRequire(length <= 0x7fffffff);
    reader.require(at, length + 12);
    const kind = reader.u32be(at + 4);
    // Unknown chunks stay opaque and counted; never search payload bytes for
    // animation-like text. The reserved third type byte must be uppercase.
    for (let index = 0; index < 4; index++) {
      const byte = (kind >>> (24 - index * 8)) & 255;
      const upper = byte >= 65 && byte <= 90;
      rasterRequire(upper || (index !== 2 && byte >= 97 && byte <= 122));
    }
    const data = at + 8;
    const end = data + length;
    if (imageSeen && kind !== IDAT) imageEnded = true;
    rasterRequire(kind !== IHDR);
    if (kind === ACTL) {
      rasterRequire(!declaredFrames && !imageSeen && !frames && length === 8);
      controlCrc(reader, at + 4, end);
      declaredFrames = reader.u32be(data);
      rasterRequire(declaredFrames > 0 && reader.u32be(data + 4) <= 0x7fffffff);
      rasterFrames(canvasPixels, declaredFrames);
    } else if (kind === FCTL) {
      rasterRequire(declaredFrames && length === 26);
      controlCrc(reader, at + 4, end);
      rasterRequire(reader.u32be(data) === sequence++);
      rasterRequire(!current || frameBytes > 0);
      rasterRequire(++frames <= declaredFrames);
      const frameWidth = reader.u32be(data + 4);
      const frameHeight = reader.u32be(data + 8);
      const x = reader.u32be(data + 12);
      const y = reader.u32be(data + 16);
      rasterCanvas(frameWidth, frameHeight);
      rasterRequire(
        x + frameWidth <= width &&
          y + frameHeight <= height &&
          reader.u8(data + 24) <= 2 &&
          reader.u8(data + 25) <= 1,
      );
      if (!imageSeen) {
        // A default image participating in the animation must fill IHDR.
        rasterRequire(
          frames === 1 &&
            !x &&
            !y &&
            frameWidth === width &&
            frameHeight === height,
        );
        current = "default";
      } else {
        if (
          frames === 1 &&
          canvasPixels * (declaredFrames + 1) > MAX_MESSAGE_RASTER_FRAME_PIXELS
        )
          // A separate static poster may also be decoded. Charge its canvas
          // in addition to all animation frames, without calling it a frame.
          throw new MessageRasterError("tooComplex");
        current = "frame";
      }
      frameBytes = 0;
    } else if (kind === FDAT) {
      rasterRequire(
        declaredFrames && imageSeen && current === "frame" && length >= 4,
      );
      rasterRequire(reader.u32be(data) === sequence++);
      frameBytes += length - 4;
    } else if (kind === IDAT) {
      rasterRequire(!imageEnded && current !== "frame");
      imageSeen = true;
      imageBytes += length;
      if (current === "default") frameBytes += length;
    } else if (kind === IEND) {
      rasterRequire(!length && end + 4 === reader.length && imageBytes > 0);
      // Full PNG image validity remains the browser's job. This checks only
      // required data presence and exact APNG frame/control ownership.
      rasterRequire(
        !declaredFrames || (frames === declaredFrames && frameBytes > 0),
      );
      return;
    }
    at = end + 4;
  }
  rasterRequire(false);
}
