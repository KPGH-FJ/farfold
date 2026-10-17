import {
  MAX_MESSAGE_RASTER_FRAME_PIXELS,
  MessageRasterError,
  MessageRasterReader,
  rasterCanvas,
  rasterRecord,
  rasterRequire,
} from "./message_raster_reader";

export interface AvifBox {
  kind: string;
  data: number;
  end: number;
  depth: number;
}
export interface AvifDimensions {
  width: number;
  height: number;
}

/** Container declarations only: no image decoder, binary copy or payload scan.
 * One budget covers boxes, item associations, references and table records. */
export class AvifContext {
  records = 0;
  pixels = 0;
  declarations = 0;
  uncovered = false;
  constructor(readonly reader: MessageRasterReader) {}
  record(count = 1): void {
    rasterRequire(Number.isSafeInteger(count) && count >= 0);
    this.records += count;
    rasterRecord(this.records);
  }
  dimensions(width: number, height: number): AvifDimensions {
    rasterCanvas(width, height);
    this.declarations++;
    return { width, height };
  }
  charge(size: AvifDimensions, copies = 1): void {
    rasterRequire(Number.isSafeInteger(copies) && copies >= 0);
    this.pixels += size.width * size.height * copies;
    if (this.pixels > MAX_MESSAGE_RASTER_FRAME_PIXELS)
      throw new MessageRasterError("tooComplex");
  }
  *boxes(start: number, end: number, depth = 0): Generator<AvifBox> {
    if (depth > 16) throw new MessageRasterError("tooComplex");
    this.reader.require(start, end - start);
    let at = start;
    while (at < end) {
      this.record();
      rasterRequire(at + 8 <= end);
      let size = this.reader.u32be(at);
      const kind = this.text(at + 4);
      let header = 8;
      if (size === 1) {
        rasterRequire(at + 16 <= end && this.reader.u32be(at + 8) === 0);
        size = this.reader.u32be(at + 12);
        header = 16;
      } else if (!size) size = end - at;
      if (kind === "uuid") header += 16;
      rasterRequire(size >= header && at + size <= end);
      yield { kind, data: at + header, end: at + size, depth };
      at += size;
    }
  }
  children(box: AvifBox, skip = 0): Generator<AvifBox> {
    return this.boxes(box.data + skip, box.end, box.depth + 1);
  }
  text(at: number): string {
    const value = this.reader.u32be(at);
    return String.fromCharCode(
      value >>> 24,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    );
  }
}

export class AvifCursor {
  at: number;
  constructor(
    readonly context: AvifContext,
    readonly box: AvifBox,
  ) {
    this.at = box.data;
  }
  uint(bytes: number): number {
    rasterRequire(bytes >= 0 && bytes <= 8 && this.at + bytes <= this.box.end);
    let value = 0;
    for (let i = 0; i < bytes; i++)
      value = value * 256 + this.context.reader.u8(this.at++);
    rasterRequire(Number.isSafeInteger(value));
    return value;
  }
  full(): { version: number; flags: number } {
    return { version: this.uint(1), flags: this.uint(3) };
  }
  skip(bytes: number): void {
    rasterRequire(bytes >= 0 && this.at + bytes <= this.box.end);
    this.at += bytes;
  }
  done(): void {
    rasterRequire(this.at === this.box.end);
  }
}
