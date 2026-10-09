import { deflateSync } from "node:zlib";
import { parseDocx } from "./docx_parse";
import { docxFixture } from "./docx_fixture";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectDocxImage } from "./docx_images";
import { DocxError } from "./docx_types";
const jpeg = readFileSync(
  new URL(
    "../../docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg",
    import.meta.url,
  ),
);
function exif(orientation: number, little = true, entries = 1) {
  const tiff = Buffer.alloc(8 + 2 + 12 * entries + 4);
  tiff.write(little ? "II" : "MM");
  const u16 = (v: number, o: number) =>
      little ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o),
    u32 = (v: number, o: number) =>
      little ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o);
  u16(42, 2);
  u32(8, 4);
  u16(entries, 8);
  for (let i = 0; i < entries; i++) {
    u16(0x112, 10 + 12 * i);
    u16(3, 12 + 12 * i);
    u32(1, 14 + 12 * i);
    u16(orientation, 18 + 12 * i);
  }
  const data = Buffer.concat([Buffer.from("Exif\0\0"), tiff]),
    head = Buffer.alloc(4);
  head[0] = 255;
  head[1] = 225;
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}
const withExif = (...segments: Buffer[]) =>
  Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
describe("DOCX private bounded EXIF orientation", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "accounts for orientation %d while preserving the pixel budget",
    (n) => {
      const result = inspectDocxImage(withExif(exif(n)));
      expect([result.width, result.height]).toEqual(
        n >= 5 ? [120, 80] : [80, 120],
      );
    },
  );
  it("reads big-endian TIFF", () =>
    expect(inspectDocxImage(withExif(exif(8, false))).width).toBe(120));
  it.each([0, 9, 65535])("rejects invalid orientation %d", (n) =>
    expect(() => inspectDocxImage(withExif(exif(n)))).toThrow(DocxError),
  );
  it("rejects duplicate EXIF packets and duplicate orientation tags", () => {
    expect(() => inspectDocxImage(withExif(exif(1), exif(6)))).toThrow(
      DocxError,
    );
    expect(() => inspectDocxImage(withExif(exif(1, true, 2)))).toThrow(
      DocxError,
    );
  });
  it("rejects out-of-range IFD pointers and non-SHORT orientation", () => {
    const pointer = exif(6);
    pointer.writeUInt32LE(0xfffffff0, 14);
    expect(() => inspectDocxImage(withExif(pointer))).toThrow(DocxError);
    const type = exif(6);
    type.writeUInt16LE(4, 22);
    expect(() => inspectDocxImage(withExif(type))).toThrow(DocxError);
  });
});

function png(width: number, height: number, animated = false) {
  const chunk = (kind: string, data: Buffer) => {
    const value = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const b of value) {
      crc ^= b;
      for (let i = 0; i < 8; i++)
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const h = Buffer.alloc(4),
      t = Buffer.alloc(4);
    h.writeUInt32BE(data.length);
    t.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([h, value, t]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...(animated ? [chunk("acTL", animation)] : []),
    chunk(
      "IDAT",
      deflateSync(Buffer.alloc((Math.ceil(width / 8) + 1) * height)),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("DOCX raster errors preserve their actual profile boundary", () => {
  it.each([
    [4097, 4096],
    [8193, 1],
  ])("classifies valid PNG %dx%d as limit", (w, h) => {
    const bytes = png(w, h);
    expect(() => inspectDocxImage(bytes)).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
    const input = docxFixture("05-inline-png-jpeg");
    input.parts.find((p) => p.name.endsWith(".png"))!.data =
      bytes.toString("base64");
    expect(() => parseDocx(input)).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
  });
  it("classifies PNG animation declaration as unsupported", () =>
    expect(() => inspectDocxImage(png(8, 8, true))).toThrowError(
      expect.objectContaining({ code: "unsupported" }),
    ));
});
