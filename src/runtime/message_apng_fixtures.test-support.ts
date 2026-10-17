import { crc32 } from "node:zlib";

// Exact tiny Pillow APNG already used by image_bytes.test.ts. No large raster
// is encoded or decoded; changed dimensions below are metadata-only fixtures.
export const MESSAGE_APNG_TEST_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAQAAAAAAAAAAAGQD6AAAECjlZAAAAAxJREFUeJxj/M8AAgAGCAEBWs8GSAAAABpmY1RMAAAAAQAAAAIAAAABAAAAAAAAAAAAZAPoAACLWw+wAAAAE2ZkQVQAAAACeJxjZGj4z8DAAAAGigGBHdUz0wAAAABJRU5ErkJggg==";

export interface PngTestChunk {
  kind: string;
  data: Buffer;
}

export function pngTestChunks(data = MESSAGE_APNG_TEST_DATA): PngTestChunk[] {
  const bytes = Buffer.from(data, "base64");
  const chunks: PngTestChunk[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    chunks.push({
      kind: bytes.toString("ascii", at + 4, at + 8),
      data: Buffer.from(bytes.subarray(at + 8, at + 8 + length)),
    });
    at += length + 12;
  }
  return chunks;
}

export function pngTestChunk({ kind, data }: PngTestChunk): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(kind, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}

export function pngTestFile(chunks: readonly PngTestChunk[]): Buffer {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunks.map(pngTestChunk),
  ]);
}

export function apngTestFile({
  width = 2,
  height = 1,
  frames = 2,
  defaultIncluded = true,
  plays = 0,
}: {
  width?: number;
  height?: number;
  frames?: number;
  defaultIncluded?: boolean;
  plays?: number;
} = {}): Buffer {
  const original = pngTestChunks();
  const header = Buffer.from(original[0].data);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(frames);
  animation.writeUInt32BE(plays, 4);
  const image = original.find((chunk) => chunk.kind === "IDAT")!.data;
  const chunks: PngTestChunk[] = [
    { kind: "IHDR", data: header },
    { kind: "acTL", data: animation },
  ];
  let sequence = 0;
  if (!defaultIncluded) chunks.push({ kind: "IDAT", data: image });
  for (let index = 0; index < frames; index++) {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence++);
    control.writeUInt32BE(width, 4);
    control.writeUInt32BE(height, 8);
    control.writeUInt16BE(100, 20);
    control.writeUInt16BE(1000, 22);
    chunks.push({ kind: "fcTL", data: control });
    if (defaultIncluded && index === 0)
      chunks.push({ kind: "IDAT", data: image });
    else {
      const frame = Buffer.alloc(image.length + 4);
      frame.writeUInt32BE(sequence++);
      image.copy(frame, 4);
      chunks.push({ kind: "fdAT", data: frame });
    }
  }
  chunks.push({ kind: "IEND", data: Buffer.alloc(0) });
  return pngTestFile(chunks);
}
