import {
  MessageRasterReader,
  rasterCanvas,
  rasterFrames,
  rasterRecord,
  rasterRequire,
} from "./message_raster_reader";

/** GIF87a/GIF89a container declarations, not an LZW decoder. Every image (and
 * plain-text graphic) is charged at the full logical screen. Loop counts and
 * delays do not bound playback time or the browser decoder's memory. */
export function messageGifAdmission(reader: MessageRasterReader): void {
  rasterRequire(reader.matches(0, "GIF87a") || reader.matches(0, "GIF89a"));
  reader.require(0, 13);
  const width = reader.u16le(6);
  const height = reader.u16le(8);
  rasterCanvas(width, height);
  const packed = reader.u8(10);
  const globalColors = packed & 0x80 ? 2 ** ((packed & 7) + 1) : 0;
  let at = 13;
  reader.require(at, globalColors * 3);
  at += globalColors * 3;
  if (globalColors) rasterRequire(reader.u8(11) < globalColors);

  let records = 0;
  let frames = 0;
  const record = () => rasterRecord(++records);
  const frame = () => rasterFrames(width * height, ++frames);
  const rectangle = (start: number): void => {
    const frameWidth = reader.u16le(start + 4);
    const frameHeight = reader.u16le(start + 6);
    rasterCanvas(frameWidth, frameHeight);
    rasterRequire(
      reader.u16le(start) + frameWidth <= width &&
        reader.u16le(start + 2) + frameHeight <= height,
    );
  };
  // Count top-level blocks and every data sub-block, including fixed extension
  // headers and the zero terminators. Payload bytes are skipped by their length.
  const subblocks = (): number => {
    let bytes = 0;
    for (;;) {
      record();
      const length = reader.u8(at++);
      reader.require(at, length);
      at += length;
      bytes += length;
      if (!length) return bytes;
    }
  };
  const fixedBlock = (length: number): number => {
    record();
    rasterRequire(reader.u8(at++) === length);
    reader.require(at, length);
    const start = at;
    at += length;
    return start;
  };

  while (at < reader.length) {
    record();
    const block = reader.u8(at++);
    if (block === 0x3b) {
      rasterRequire(frames > 0 && at === reader.length);
      return;
    }
    if (block === 0x21) {
      const label = reader.u8(at++);
      if (label === 0xf9) {
        const data = fixedBlock(4);
        const control = reader.u8(data);
        rasterRequire(!(control & 0xe0) && ((control >>> 2) & 7) <= 3);
        record();
        rasterRequire(reader.u8(at++) === 0);
      } else if (label === 0xff) {
        fixedBlock(11);
        subblocks();
      } else if (label === 0xfe) {
        subblocks();
      } else if (label === 0x01) {
        const data = fixedBlock(12);
        rectangle(data);
        rasterRequire(
          globalColors > 0 &&
            reader.u8(data + 8) > 0 &&
            reader.u8(data + 9) > 0 &&
            reader.u8(data + 10) < globalColors &&
            reader.u8(data + 11) < globalColors,
        );
        frame();
        subblocks();
      } else {
        // An unknown extension's rendering semantics cannot be budgeted here.
        rasterRequire(false);
      }
      continue;
    }

    rasterRequire(block === 0x2c);
    reader.require(at, 9);
    rectangle(at);
    const localPacked = reader.u8(at + 8);
    rasterRequire(!(localPacked & 0x18));
    const localColors = localPacked & 0x80 ? 2 ** ((localPacked & 7) + 1) : 0;
    at += 9;
    reader.require(at, localColors * 3);
    at += localColors * 3;
    rasterRequire(localColors > 0 || globalColors > 0);
    const codeSize = reader.u8(at++);
    rasterRequire(codeSize >= 2 && codeSize <= 8);
    frame();
    rasterRequire(subblocks() > 0);
  }
  rasterRequire(false); // A complete stream has exactly one final trailer.
}
