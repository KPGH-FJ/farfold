import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from "./image_bytes";

export type MessageRasterRejection = "invalid" | "tooManyPixels" | "tooComplex";
export const MAX_MESSAGE_RASTER_FRAMES = 128;
export const MAX_MESSAGE_RASTER_FRAME_PIXELS = 67_108_864;
export const MAX_MESSAGE_RASTER_RECORDS = 65_536;

export class MessageRasterError extends Error {
  constructor(readonly reason: MessageRasterRejection) {
    super(reason);
  }
}

export function rasterRequire(value: unknown): asserts value {
  if (!value) throw new MessageRasterError("invalid");
}

/** Metadata limits only. This does not estimate the browser codec's allocation. */
export function rasterCanvas(width: number, height: number): void {
  rasterRequire(
    Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0,
  );
  if (
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new MessageRasterError("tooManyPixels");
}

/** Count each frame at the complete canvas, even when its rectangle is small.
 * Repeated playback/looping and actual decoder memory remain outside this sum. */
export function rasterFrames(canvasPixels: number, frames: number): void {
  if (
    frames > MAX_MESSAGE_RASTER_FRAMES ||
    canvasPixels * frames > MAX_MESSAGE_RASTER_FRAME_PIXELS
  )
    throw new MessageRasterError("tooComplex");
}

export function rasterRecord(count: number): void {
  if (count > MAX_MESSAGE_RASTER_RECORDS)
    throw new MessageRasterError("tooComplex");
}

function value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : 0;
}

/** Random-access view of already canonical, byte-budgeted Base64. No complete
 * binary string, decoded buffer, URL or browser decoder is created here. The
 * caller must run canonical Base64 and byte admission before constructing it. */
export class MessageRasterReader {
  readonly length: number;
  constructor(private readonly data: string) {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    this.length = (data.length / 4) * 3 - padding;
  }
  require(at: number, length: number): void {
    rasterRequire(
      Number.isSafeInteger(at) &&
        Number.isSafeInteger(length) &&
        at >= 0 &&
        length >= 0 &&
        at + length <= this.length,
    );
  }
  u8(at: number): number {
    this.require(at, 1);
    const start = Math.floor(at / 3) * 4;
    const offset = at % 3;
    const left = value(this.data.charCodeAt(start + offset));
    const right = value(this.data.charCodeAt(start + offset + 1));
    return offset === 0
      ? (left << 2) | (right >>> 4)
      : offset === 1
        ? ((left & 15) << 4) | (right >>> 2)
        : ((left & 3) << 6) | right;
  }
  u16le(at: number): number {
    return this.u8(at) + this.u8(at + 1) * 256;
  }
  u16be(at: number): number {
    return this.u8(at) * 256 + this.u8(at + 1);
  }
  u24le(at: number): number {
    return this.u16le(at) + this.u8(at + 2) * 65_536;
  }
  u32le(at: number): number {
    return this.u16le(at) + this.u16le(at + 2) * 65_536;
  }
  u32be(at: number): number {
    return this.u16be(at) * 65_536 + this.u16be(at + 2);
  }
  matches(at: number, text: string): boolean {
    if (at < 0 || at + text.length > this.length) return false;
    for (let i = 0; i < text.length; i++)
      if (this.u8(at + i) !== text.charCodeAt(i)) return false;
    return true;
  }
}
