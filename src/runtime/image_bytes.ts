export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_IMAGE_EDGE = 8192;

export const IMAGE_BYTES_STRINGS = {
  invalid: "图片格式或内容无法读取，请重新添加 PNG、JPEG、GIF 或 WebP 图片。",
  tooLarge: "图片大小超过 8 MiB，请缩小后重新添加。",
  tooManyPixels: "图片尺寸过大，请缩小后重新添加。",
  animated: "暂不支持动画图片，请添加静态图片。",
} as const;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface ImageBytesInspection {
  mimeType: ImageMime;
  width: number;
  height: number;
}

type Dimensions = Pick<ImageBytesInspection, "width" | "height">;
function invalid(): never {
  throw new Error(IMAGE_BYTES_STRINGS.invalid);
}
function animated(): never {
  throw new Error(IMAGE_BYTES_STRINGS.animated);
}
function range(bytes: Uint8Array, at: number, length: number) {
  if (at < 0 || length < 0 || at + length > bytes.length) invalid();
}
function matches(bytes: Uint8Array, at: number, pattern: readonly number[]) {
  return (
    at + pattern.length <= bytes.length &&
    pattern.every((value, index) => bytes[at + index] === value)
  );
}
function text(bytes: Uint8Array, at: number, length: number) {
  range(bytes, at, length);
  return String.fromCharCode(...bytes.subarray(at, at + length));
}
function be16(bytes: Uint8Array, at: number) {
  range(bytes, at, 2);
  return bytes[at] * 256 + bytes[at + 1];
}
function le16(bytes: Uint8Array, at: number) {
  range(bytes, at, 2);
  return bytes[at] + bytes[at + 1] * 256;
}
function le24(bytes: Uint8Array, at: number) {
  range(bytes, at, 3);
  return le16(bytes, at) + bytes[at + 2] * 65536;
}
function be32(bytes: Uint8Array, at: number) {
  range(bytes, at, 4);
  return be16(bytes, at) * 65536 + be16(bytes, at + 2);
}
function le32(bytes: Uint8Array, at: number) {
  range(bytes, at, 4);
  return le16(bytes, at) + le16(bytes, at + 2) * 65536;
}
function dimensions(width: number, height: number): Dimensions {
  if (!width || !height) invalid();
  if (
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new Error(IMAGE_BYTES_STRINGS.tooManyPixels);
  return { width, height };
}

/** A signature selects a parser, never proves that the image is decodable. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (!(bytes instanceof Uint8Array)) return null;
  if (matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (matches(bytes, 0, [255, 216, 255])) return "image/jpeg";
  if (
    matches(bytes, 0, [71, 73, 70, 56, 55, 97]) ||
    matches(bytes, 0, [71, 73, 70, 56, 57, 97])
  )
    return "image/gif";
  if (
    matches(bytes, 0, [82, 73, 70, 70]) &&
    matches(bytes, 8, [87, 69, 66, 80, 86, 80])
  )
    return "image/webp";
  return null;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function pngCrc(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let at = start; at < end; at++)
    crc = crcTable[(crc ^ bytes[at]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// PNG chunks, dimensions and animation declarations follow W3C PNG. Check the
// zlib and first DEFLATE headers before letting the browser decode the data.
function png(bytes: Uint8Array): Dimensions {
  let size: Dimensions | undefined;
  let at = 8;
  let color = -1;
  let palette = false;
  let imageSeen = false;
  let imageBytes = 0;
  let imageEnded = false;
  const zlibPrefix: number[] = [];
  while (at < bytes.length) {
    range(bytes, at, 12);
    const length = be32(bytes, at);
    range(bytes, at, length + 12);
    const kind = text(bytes, at + 4, 4);
    const data = at + 8;
    const end = data + length;
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind)) invalid();
    if (pngCrc(bytes, at + 4, end) !== be32(bytes, end)) invalid();
    if (!size && kind !== "IHDR") invalid();
    if (["acTL", "fcTL", "fdAT"].includes(kind)) animated();
    if (kind === "IHDR") {
      if (size || at !== 8 || length !== 13) invalid();
      size = dimensions(be32(bytes, data), be32(bytes, data + 4));
      const depth = bytes[data + 8];
      color = bytes[data + 9];
      const allowedDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !allowedDepths[color]?.includes(depth) ||
        bytes[data + 10] !== 0 ||
        bytes[data + 11] !== 0 ||
        bytes[data + 12] > 1
      )
        invalid();
    } else if (kind === "PLTE") {
      if (
        palette ||
        imageSeen ||
        color === 0 ||
        color === 4 ||
        !length ||
        length > 768 ||
        length % 3
      )
        invalid();
      palette = true;
    } else if (kind === "IDAT") {
      if (imageEnded || (color === 3 && !palette)) invalid();
      imageSeen = true;
      for (let i = 0; i < length && zlibPrefix.length < 3; i++)
        zlibPrefix.push(bytes[data + i]);
      imageBytes += length;
    } else {
      if (imageSeen) imageEnded = true;
      if (kind === "IEND") {
        // Two zlib header bytes, a DEFLATE header byte and four Adler-32 bytes.
        if (!size || length || end + 4 !== bytes.length || imageBytes < 7)
          invalid();
        const [cmf, flg, firstBlock] = zlibPrefix;
        if (
          (cmf & 15) !== 8 ||
          cmf >>> 4 > 7 ||
          flg & 32 ||
          (cmf * 256 + flg) % 31 ||
          // RFC 1951 §3.2.3 reserves BTYPE=11 (bits 1 and 2, after BFINAL).
          (firstBlock & 0b110) === 0b110
        )
          invalid();
        return size;
      }
      if (kind[0] === kind[0].toUpperCase()) invalid();
    }
    at = end + 4;
  }
  return invalid();
}

// JPEG T.81 marker framing, 8-bit SOF0/1/2 and scans. Entropy and complete
// Huffman correctness remain the decoder's job; deferred heights are rejected.
function jpeg(bytes: Uint8Array): Dimensions {
  let at = 2;
  let size: Dimensions | undefined;
  const components = new Set<number>();
  let scan = false;
  let frameMarker = 0;
  let quantization = false;
  let huffman = false;
  while (at < bytes.length) {
    if (bytes[at++] !== 255) invalid();
    while (at < bytes.length && bytes[at] === 255) at++;
    range(bytes, at, 1);
    const marker = bytes[at++];
    if (marker === 0xd9) {
      if (!size || !scan || at !== bytes.length) invalid();
      return size;
    }
    const frame = marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
    if (
      !frame &&
      marker !== 0xc4 &&
      marker !== 0xdb &&
      marker !== 0xdd &&
      marker !== 0xda &&
      !(marker >= 0xe0 && marker <= 0xef) &&
      marker !== 0xfe
    )
      invalid();
    const length = be16(bytes, at);
    if (length < 2) invalid();
    range(bytes, at, length);
    const end = at + length;
    const data = at + 2;
    if (frame) {
      if (size || scan || length < 8 || bytes[data] !== 8) invalid();
      frameMarker = marker;
      size = dimensions(be16(bytes, data + 3), be16(bytes, data + 1));
      const count = bytes[data + 5];
      if (!count || count > 4 || length !== 8 + count * 3) invalid();
      for (let i = data + 6; i < end; i += 3) {
        const sampling = bytes[i + 1];
        if (
          components.has(bytes[i]) ||
          !(sampling >>> 4) ||
          sampling >>> 4 > 4 ||
          !(sampling & 15) ||
          (sampling & 15) > 4 ||
          bytes[i + 2] > 3
        )
          invalid();
        components.add(bytes[i]);
      }
    } else if (marker === 0xdb) {
      let i = data;
      while (i < end) {
        const precision = bytes[i] >>> 4;
        if (precision > 1 || (bytes[i] & 15) > 3) invalid();
        i += 1 + 64 * (precision + 1);
        if (i > end) invalid();
        quantization = true;
      }
    } else if (marker === 0xc4) {
      let i = data;
      while (i < end) {
        if (i + 17 > end || bytes[i] >>> 4 > 1 || (bytes[i] & 15) > 3)
          invalid();
        let symbols = 0;
        for (let j = i + 1; j < i + 17; j++) symbols += bytes[j];
        if (!symbols || symbols > 256 || i + 17 + symbols > end) invalid();
        i += 17 + symbols;
        huffman = true;
      }
    } else if (marker === 0xdd) {
      if (length !== 4) invalid();
    } else if (marker === 0xda) {
      if (!size || !quantization || !huffman || length < 6) invalid();
      const count = bytes[data];
      if (!count || count > components.size || length !== 6 + 2 * count)
        invalid();
      const selected = new Set<number>();
      for (let i = data + 1; i < data + 1 + 2 * count; i += 2) {
        if (
          !components.has(bytes[i]) ||
          selected.has(bytes[i]) ||
          bytes[i + 1] >>> 4 > 3 ||
          (bytes[i + 1] & 15) > 3
        )
          invalid();
        selected.add(bytes[i]);
      }
      const start = bytes[end - 3];
      const stop = bytes[end - 2];
      const approximation = bytes[end - 1];
      if (
        start > stop ||
        stop > 63 ||
        approximation >>> 4 > 13 ||
        (approximation & 15) > 13
      )
        invalid();
      if (
        frameMarker !== 0xc2
          ? start !== 0 || stop !== 63 || approximation !== 0
          : (start === 0 && stop !== 0) || (start > 0 && count !== 1)
      )
        invalid();
      at = end;
      let entropy = false;
      while (at < bytes.length) {
        if (bytes[at] !== 255) {
          entropy = true;
          at++;
          continue;
        }
        let next = at + 1;
        while (next < bytes.length && bytes[next] === 255) next++;
        range(bytes, next, 1);
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) {
          if (bytes[next] === 0) entropy = true;
          at = next + 1;
        } else break;
      }
      if (!entropy) invalid();
      scan = true;
      continue;
    }
    at = end;
  }
  return invalid();
}

function subblocks(bytes: Uint8Array, start: number) {
  let at = start;
  let dataBytes = 0;
  while (at < bytes.length) {
    const length = bytes[at++];
    if (!length) return { end: at, dataBytes };
    range(bytes, at, length);
    dataBytes += length;
    at += length;
  }
  return invalid();
}

// GIF89a framing includes every descriptor, so an extra or oversized hidden
// image cannot be accepted merely because the logical screen is small.
function gif(bytes: Uint8Array): Dimensions {
  range(bytes, 6, 7);
  const size = dimensions(le16(bytes, 6), le16(bytes, 8));
  let at = 13;
  const globalPalette = Boolean(bytes[10] & 128);
  if (globalPalette) at += 3 * 2 ** ((bytes[10] & 7) + 1);
  range(bytes, 0, at);
  let images = 0;
  while (at < bytes.length) {
    const kind = bytes[at++];
    if (kind === 0x3b) {
      if (images !== 1 || at !== bytes.length) invalid();
      return size;
    }
    if (kind === 0x21) {
      range(bytes, at, 1);
      const label = bytes[at++];
      if (label === 0xf9) {
        range(bytes, at, 6);
        if (
          bytes[at] !== 4 ||
          bytes[at + 5] !== 0 ||
          bytes[at + 1] & 224 ||
          ((bytes[at + 1] >>> 2) & 7) > 3
        )
          invalid();
        at += 6;
      } else if (label === 0xff) {
        range(bytes, at, 12);
        if (bytes[at++] !== 11) invalid();
        at = subblocks(bytes, at + 11).end;
      } else if (label === 0xfe) at = subblocks(bytes, at).end;
      else invalid();
      continue;
    }
    if (kind !== 0x2c) invalid();
    if (++images > 1) animated();
    range(bytes, at, 9);
    const frame = dimensions(le16(bytes, at + 4), le16(bytes, at + 6));
    if (
      le16(bytes, at) + frame.width > size.width ||
      le16(bytes, at + 2) + frame.height > size.height ||
      bytes[at + 8] & 24
    )
      invalid();
    const flags = bytes[at + 8];
    if (!globalPalette && !(flags & 128)) invalid();
    at += 9;
    if (flags & 128) at += 3 * 2 ** ((flags & 7) + 1);
    range(bytes, at, 1);
    if (bytes[at] < 2 || bytes[at] > 8) invalid();
    const image = subblocks(bytes, at + 1);
    if (!image.dataBytes) invalid();
    at = image.end;
  }
  return invalid();
}

// Google WebP RIFF and VP8/VP8L dimensions. Inspect both canvas and bitstream
// dimensions, not only VP8X; no animation container or duplicate image passes.
function webp(bytes: Uint8Array): Dimensions {
  if (le32(bytes, 4) + 8 !== bytes.length || bytes.length % 2) invalid();
  let at = 12;
  let canvas: Dimensions | undefined;
  let image: Dimensions | undefined;
  let flags = 0;
  let alpha = false;
  let codec = "";
  const metadata = new Set<string>();
  while (at < bytes.length) {
    range(bytes, at, 8);
    const kind = text(bytes, at, 4);
    const length = le32(bytes, at + 4);
    const data = at + 8;
    range(bytes, data, length + (length & 1));
    if (length & 1 && bytes[data + length] !== 0) invalid();
    if (kind === "ANIM" || kind === "ANMF") animated();
    if (kind === "VP8X") {
      if (at !== 12 || canvas || length !== 10) invalid();
      flags = bytes[data];
      if (flags & 2) animated();
      if (flags & 193 || le24(bytes, data + 1)) invalid();
      canvas = dimensions(le24(bytes, data + 4) + 1, le24(bytes, data + 7) + 1);
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (image) invalid();
      codec = kind;
      if (kind === "VP8 ") {
        if (length < 11 || !matches(bytes, data + 3, [157, 1, 42])) invalid();
        const tag = le24(bytes, data);
        if (
          tag & 1 ||
          ((tag >>> 1) & 7) > 3 ||
          !(tag & 16) ||
          tag >>> 5 > length - 10
        )
          invalid();
        image = dimensions(
          le16(bytes, data + 6) & 16383,
          le16(bytes, data + 8) & 16383,
        );
      } else {
        if (length < 6 || bytes[data] !== 47 || le32(bytes, data + 1) >>> 29)
          invalid();
        const header = le32(bytes, data + 1);
        image = dimensions((header & 16383) + 1, ((header >>> 14) & 16383) + 1);
        if (alpha) invalid();
      }
      if (
        canvas &&
        (canvas.width !== image.width || canvas.height !== image.height)
      )
        invalid();
    } else if (kind === "ALPH") {
      if (
        !canvas ||
        !(flags & 16) ||
        alpha ||
        image ||
        length < 2 ||
        bytes[data] & 192 ||
        (bytes[data] & 3) > 1 ||
        ((bytes[data] >>> 4) & 3) > 1
      )
        invalid();
      alpha = true;
    } else if (["ICCP", "EXIF", "XMP "].includes(kind)) {
      if (
        !canvas ||
        !length ||
        metadata.has(kind) ||
        (kind === "ICCP" && (image || alpha))
      )
        invalid();
      metadata.add(kind);
    } else if (!/^[\x20-\x7e]{4}$/.test(kind)) invalid();
    at = data + length + (length & 1);
  }
  if (!image || (alpha && codec !== "VP8 ")) invalid();
  if (canvas) {
    for (const [bit, kind] of [
      [32, "ICCP"],
      [8, "EXIF"],
      [4, "XMP "],
    ] as const)
      if (Boolean(flags & bit) !== metadata.has(kind)) invalid();
    if (codec === "VP8 " && Boolean(flags & 16) !== alpha) invalid();
  }
  return image;
}

/** Bounded structural preflight for four static raster formats. This is not a
 * codec decoder: callers MUST also decode these same bytes before using them. */
export function inspectImageBytes(bytes: Uint8Array): ImageBytesInspection {
  if (!(bytes instanceof Uint8Array)) invalid();
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error(IMAGE_BYTES_STRINGS.tooLarge);
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) invalid();
  const size =
    mimeType === "image/png"
      ? png(bytes)
      : mimeType === "image/jpeg"
        ? jpeg(bytes)
        : mimeType === "image/gif"
          ? gif(bytes)
          : webp(bytes);
  return { mimeType, ...size };
}
