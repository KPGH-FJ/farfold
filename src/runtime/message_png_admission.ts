import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from "./image_bytes";

type PngCanvasAdmission =
  "notPng" | "withinBudget" | "invalid" | "tooManyPixels";

/** Called only after canonical Base64 and the message byte limit are checked.
 * Inspect at most 33 decoded bytes, never a decoder, URL or complete buffer.
 * A CRC-checked IHDR's declared canvas is not proof of valid image data, actual
 * decoded resources, animation bounds, or even the presence of IDAT/IEND. */
export function messagePngAdmission(
  data: string,
  declaredPng: boolean,
): PngCanvasAdmission {
  let header: string;
  try {
    header = atob(data.slice(0, 44));
  } catch {
    return "invalid";
  }
  const signature = header.startsWith("\x89PNG\r\n\x1a\n");
  // Other allowed image MIME declarations may still be sniffed as PNG by the
  // browser. Such bytes must pass the same check, never a MIME-only fallback.
  if (!signature) return declaredPng ? "invalid" : "notPng";
  if (header.length !== 33 || header.slice(8, 16) !== "\0\0\0\rIHDR")
    return "invalid";
  const byte = (at: number) => header.charCodeAt(at);
  const u32 = (at: number) =>
    byte(at) * 16777216 +
    byte(at + 1) * 65536 +
    byte(at + 2) * 256 +
    byte(at + 3);
  let crc = 0xffffffff;
  for (let at = 12; at < 29; at++) {
    crc ^= byte(at);
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  if ((crc ^ 0xffffffff) >>> 0 !== u32(29)) return "invalid";
  const width = u32(16),
    height = u32(20);
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !width ||
    !height ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !depths[byte(25)]?.includes(byte(24)) ||
    byte(26) !== 0 ||
    byte(27) !== 0 ||
    byte(28) > 1
  )
    return "invalid";
  // Check edges before multiplication: the remaining product is exact and small.
  return width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
    ? "tooManyPixels"
    : "withinBudget";
}
