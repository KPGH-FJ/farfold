import {
  inspectImageBytes,
  IMAGE_BYTES_STRINGS,
  type ImageBytesInspection,
} from "./image_bytes";
import { DocxError } from "./docx_types";
/** Reads only the primary IFD's orientation. No thumbnail, nested IFD, external
 * profile, or offset payload is interpreted. TIFF/Exif orientation is 1..8. */
function orientation(bytes: Uint8Array): number {
  let at = 2,
    result = 1,
    seen = false,
    segments = 0;
  const fail = (): never => {
    throw new DocxError("invalid");
  };
  const be16 = (offset: number) => {
    if (offset + 2 > bytes.length) fail();
    return bytes[offset] * 256 + bytes[offset + 1];
  };
  while (at < bytes.length) {
    if (++segments > 4096) throw new DocxError("limit");
    if (bytes[at++] !== 255) fail();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) break;
    const length = be16(at),
      start = at + 2,
      end = at + length;
    if (length < 2 || end > bytes.length) fail();
    if (
      marker === 0xe1 &&
      bytes[start] === 69 &&
      bytes[start + 1] === 120 &&
      bytes[start + 2] === 105 &&
      bytes[start + 3] === 102
    ) {
      if (
        seen ||
        length < 16 ||
        bytes[start + 4] !== 0 ||
        bytes[start + 5] !== 0
      )
        fail();
      seen = true;
      const base = start + 6,
        little = bytes[base] === 73 && bytes[base + 1] === 73;
      if (!little && !(bytes[base] === 77 && bytes[base + 1] === 77)) fail();
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + base,
        end - base,
      );
      const u16 = (offset: number) => {
        if (offset < 0 || offset + 2 > view.byteLength) fail();
        return view.getUint16(offset, little);
      };
      const u32 = (offset: number) => {
        if (offset < 0 || offset + 4 > view.byteLength) fail();
        return view.getUint32(offset, little);
      };
      if (u16(2) !== 42) fail();
      const first = u32(4);
      if (first < 8) fail();
      const count = u16(first);
      if (count > 512) throw new DocxError("limit");
      if (first + 2 + count * 12 + 4 > view.byteLength) fail();
      let tagSeen = false;
      for (let i = 0; i < count; i++) {
        const item = first + 2 + i * 12;
        if (u16(item) !== 0x112) continue;
        if (tagSeen || u16(item + 2) !== 3 || u32(item + 4) !== 1) fail();
        tagSeen = true;
        result = u16(item + 8);
        if (result < 1 || result > 8) fail();
      }
    }
    at = end;
    if (marker === 0xda) {
      // Entropy-coded bytes can contain stuffed FF and restart markers. Scan
      // through them so another EXIF packet cannot bypass ambiguity checks.
      while (at < bytes.length) {
        if (bytes[at] !== 255) {
          at++;
          continue;
        }
        let next = at + 1;
        while (bytes[next] === 255) next++;
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7))
          at = next + 1;
        else break;
      }
    }
  }
  return result;
}
/** Dimensions match browser from-image decoding, including rotated EXIF.
 * Existing global raster validation/pixel limits remain unchanged. */
export function inspectDocxImage(bytes: Uint8Array): ImageBytesInspection {
  let info: ImageBytesInspection;
  try {
    info = inspectImageBytes(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    if (
      message === IMAGE_BYTES_STRINGS.tooLarge ||
      message === IMAGE_BYTES_STRINGS.tooManyPixels
    )
      throw new DocxError("limit");
    if (message === IMAGE_BYTES_STRINGS.animated)
      throw new DocxError("unsupported");
    throw new DocxError("invalid");
  }
  if (info.mimeType !== "image/jpeg") return info;
  return orientation(bytes) >= 5
    ? { ...info, width: info.height, height: info.width }
    : info;
}
