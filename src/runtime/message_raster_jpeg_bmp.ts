import {
  MessageRasterReader,
  rasterCanvas,
  rasterRecord,
  rasterRequire,
} from "./message_raster_reader";

const JPEG_FRAMES = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** T.81 SOF declaration only: no entropy, complete-file or decoder guarantee.
 * Length-delimited metadata may be large; skip its payload without copying it.
 * A deferred height cannot establish a canvas before the decoder starts. */
export function messageJpegAdmission(reader: MessageRasterReader): void {
  rasterRequire(reader.matches(0, "\xff\xd8"));
  let at = 2;
  let records = 0;
  while (at < reader.length) {
    rasterRecord(++records);
    rasterRequire(reader.u8(at++) === 0xff);
    while (at < reader.length && reader.u8(at) === 0xff) {
      rasterRecord(++records);
      at++;
    }
    const marker = reader.u8(at++);
    // No scan or premature end before a trustworthy frame. Hierarchical DHP/
    // EXP declarations need a separate complete hierarchy policy, not a skip.
    rasterRequire(
      marker >= 0xc0 &&
        marker !== 0xd8 &&
        marker !== 0xd9 &&
        marker !== 0xda &&
        marker !== 0xdc &&
        marker !== 0xde &&
        marker !== 0xdf &&
        !(marker >= 0xd0 && marker <= 0xd7),
    );
    const length = reader.u16be(at);
    rasterRequire(length >= 2);
    reader.require(at, length);
    if (JPEG_FRAMES.has(marker)) {
      rasterRequire(length >= 8);
      const precision = reader.u8(at + 2);
      const count = reader.u8(at + 7);
      const lossless = (marker & 3) === 3;
      rasterRequire(
        length === 8 + count * 3 &&
          count > 0 &&
          (marker === 0xc0
            ? precision === 8
            : lossless
              ? precision >= 2 && precision <= 16
              : precision === 8 || precision === 12) &&
          ((marker & 3) !== 2 || count <= 4),
      );
      const ids = new Set<number>();
      for (let component = 0; component < count; component++) {
        const field = at + 8 + component * 3;
        const id = reader.u8(field);
        const sampling = reader.u8(field + 1);
        const quantization = reader.u8(field + 2);
        rasterRequire(
          !ids.has(id) &&
            sampling >>> 4 > 0 &&
            sampling >>> 4 <= 4 &&
            (sampling & 15) > 0 &&
            (sampling & 15) <= 4 &&
            (lossless ? quantization === 0 : quantization <= 3),
        );
        ids.add(id);
      }
      rasterCanvas(reader.u16be(at + 5), reader.u16be(at + 3));
      return;
    }
    at += length;
  }
  rasterRequire(false);
}

function signed32(value: number): number {
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

/** BMP declarations and byte extents, not pixel decoding. CORE and OS/2 v2
 * dimensions are unsigned; Windows INFO/V4/V5 permits top-down signed height.
 * Embedded JPEG/PNG compression needs its own inner-canvas check and is not
 * admitted by this raster header policy. Original content remains retained. */
export function messageBmpAdmission(reader: MessageRasterReader): void {
  rasterRequire(reader.matches(0, "BM"));
  reader.require(0, 18);
  const size = reader.u32le(2);
  const pixelsAt = reader.u32le(10);
  const dib = reader.u32le(14);
  const core = dib === 12;
  const os2 = dib === 16 || dib === 64;
  rasterRequire(core || os2 || [40, 52, 56, 108, 124].includes(dib));
  reader.require(14, dib);
  rasterRequire(
    size <= reader.length &&
      size >= 14 + dib &&
      pixelsAt >= 14 + dib &&
      pixelsAt < size &&
      reader.u16le(6) === 0 &&
      reader.u16le(8) === 0,
  );
  const rawWidth = core ? reader.u16le(18) : reader.u32le(18);
  const rawHeight = core ? reader.u16le(20) : reader.u32le(22);
  const width = core || os2 ? rawWidth : signed32(rawWidth);
  const signedHeight = core || os2 ? rawHeight : signed32(rawHeight);
  const height = Math.abs(signedHeight);
  const planesAt = core ? 22 : 26;
  const bits = reader.u16le(planesAt + 2);
  rasterRequire(
    reader.u16le(planesAt) === 1 &&
      (core ? [1, 4, 8, 24] : [1, 4, 8, 16, 24, 32]).includes(bits),
  );
  rasterCanvas(width, height);
  const compression = core || dib === 16 ? 0 : reader.u32le(30);
  const imageBytes = core || dib === 16 ? 0 : reader.u32le(34);
  const colors = core || dib === 16 ? 0 : reader.u32le(46);
  // OS/2's codes3/4 are Huffman/RLE24, not Windows bitfields/JPEG.
  const validCompression = os2
    ? compression === 0 ||
      (compression === 1 && bits === 8) ||
      (compression === 2 && bits === 4) ||
      (compression === 3 && bits === 1) ||
      (compression === 4 && bits === 24)
    : compression === 0 ||
      (compression === 1 && bits === 8) ||
      (compression === 2 && bits === 4) ||
      ([3, 6].includes(compression) && [16, 32].includes(bits));
  rasterRequire(validCompression);
  rasterRequire(signedHeight >= 0 || [0, 3, 6].includes(compression));
  let masks = 0;
  if (!os2 && [3, 6].includes(compression)) {
    if (dib === 40) masks = compression === 6 ? 16 : 12;
    else rasterRequire(dib >= (compression === 6 ? 56 : 52));
  }
  if (bits <= 8) rasterRequire(colors <= 2 ** bits);
  const colorEntries = colors || (bits <= 8 ? 2 ** bits : 0);
  const paletteBytes = colorEntries * (core ? 3 : 4);
  rasterRequire(pixelsAt >= 14 + dib + masks + paletteBytes);
  const available = size - pixelsAt;
  const uncompressed =
    compression === 0 || (!os2 && [3, 6].includes(compression));
  if (uncompressed) {
    const required = Math.ceil((width * bits) / 32) * 4 * height;
    rasterRequire(
      available >= required &&
        (imageBytes === 0 ||
          (imageBytes >= required && imageBytes <= available)),
    );
  } else {
    rasterRequire(imageBytes > 0 && imageBytes <= available);
  }
}
