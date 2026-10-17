import { describe, expect, it } from "vitest";
import { MESSAGE_RASTER_TEST_DATA } from "./message_raster_fixtures.test-support";
import {
  messageBmpAdmission,
  messageJpegAdmission,
} from "./message_raster_jpeg_bmp";
import { MessageRasterReader } from "./message_raster_reader";

// Complete declarations, not a claim of complete/decodable compressed pixels.
function jpegHeader(width: number, height: number, marker = 0xc0): Uint8Array {
  return Uint8Array.from([
    255,
    216,
    255,
    marker,
    0,
    11,
    8,
    height >>> 8,
    height & 255,
    width >>> 8,
    width & 255,
    1,
    1,
    17,
    0,
  ]);
}
interface BmpOptions {
  dib?: number;
  bits?: number;
  compression?: number;
  dataBytes?: number;
  imageBytes?: number;
  colors?: number;
}
function bmp(width = 2, height = 1, o: BmpOptions = {}): Uint8Array {
  const { dib = 40, bits = 24, compression = 0, colors = 0 } = o;
  const palette =
    (colors || (bits <= 8 ? 2 ** bits : 0)) * (dib === 12 ? 3 : 4);
  const masks =
    dib === 40 && [3, 6].includes(compression)
      ? compression === 6
        ? 16
        : 12
      : 0;
  const offset = 14 + dib + masks + palette;
  const dataBytes =
    o.dataBytes ?? Math.ceil((width * bits) / 32) * 4 * Math.abs(height);
  const b = new Uint8Array(offset + dataBytes),
    v = new DataView(b.buffer);
  b.set([66, 77]);
  v.setUint32(2, b.length, true);
  v.setUint32(10, offset, true);
  v.setUint32(14, dib, true);
  if (dib === 12) {
    v.setUint16(18, width, true);
    v.setUint16(20, height, true);
    v.setUint16(22, 1, true);
    v.setUint16(24, bits, true);
  } else {
    v.setUint32(18, width, true);
    v.setUint32(22, height, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, bits, true);
    if (dib >= 40) {
      v.setUint32(30, compression, true);
      v.setUint32(34, o.imageBytes ?? (compression ? dataBytes : 0), true);
      v.setUint32(46, colors, true);
    }
  }
  return b;
}
const reader = (b: Uint8Array) =>
  new MessageRasterReader(Buffer.from(b).toString("base64"));
const jpeg = (b: Uint8Array) => messageJpegAdmission(reader(b));
const bitmap = (b: Uint8Array) => messageBmpAdmission(reader(b));
function set32(b: Uint8Array, at: number, value: number): Uint8Array {
  const c = b.slice();
  new DataView(c.buffer).setUint32(at, value, true);
  return c;
}

describe("JPEG/BMP parser declarations before preview source", () => {
  it.each(["JPEG", "JPEG_PROGRESSIVE"] as const)(
    "keeps real small %s fixture",
    (key) => {
      expect(() =>
        jpeg(
          Uint8Array.from(Buffer.from(MESSAGE_RASTER_TEST_DATA[key], "base64")),
        ),
      ).not.toThrow();
    },
  );
  it.each([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ])("reads normative SOF%i without a decoder guarantee", (marker) => {
    expect(() => jpeg(jpegHeader(4096, 4096, marker))).not.toThrow();
    expect(() => jpeg(jpegHeader(8193, 1, marker))).toThrowError(
      "tooManyPixels",
    );
  });
  it("supports12bit DCT and16bit lossless precision", () => {
    const d = jpegHeader(1, 1, 0xc1);
    d[6] = 12;
    const l = jpegHeader(1, 1, 0xc3);
    l[6] = 16;
    expect(() => jpeg(d)).not.toThrow();
    expect(() => jpeg(l)).not.toThrow();
  });
  it("keeps edge limit and rejects pixel-area excess", () => {
    expect(() => jpeg(jpegHeader(8192, 1))).not.toThrow();
    expect(() => jpeg(jpegHeader(4096, 4097))).toThrowError("tooManyPixels");
  });
  it("rejects zero/DNL height,zero width and every incomplete SOF prefix", () => {
    expect(() => jpeg(jpegHeader(1, 0))).toThrowError("invalid");
    expect(() => jpeg(jpegHeader(0, 1))).toThrowError("invalid");
    const b = jpegHeader(1, 1);
    for (let i = 0; i < b.length; i++)
      expect(() => jpeg(b.slice(0, i))).toThrowError("invalid");
  });
  it.each([0, 1, 65535])("rejects broken JPEG segment length%i", (length) => {
    expect(() =>
      jpeg(
        Uint8Array.from([255, 216, 255, 224, length >>> 8, length & 255, 0, 0]),
      ),
    ).toThrowError("invalid");
  });
  it.each([0xda, 0xd9, 0xd8, 0xdc, 0xde, 0xdf, 0xd0, 0])(
    "does not skip marker%i to invent a frame",
    (m) => {
      expect(() =>
        jpeg(
          Uint8Array.from([
            255,
            216,
            255,
            m,
            0,
            2,
            ...jpegHeader(1, 1).slice(2),
          ]),
        ),
      ).toThrowError("invalid");
    },
  );
  it("skips long APP and COM by length without decoding payloads", () => {
    const app = new Uint8Array(65537);
    app.set([255, 224, 255, 255]);
    const com = app.slice();
    com[1] = 254;
    const b = new Uint8Array(2 + app.length * 2 + 13);
    b.set([255, 216]);
    b.set(app, 2);
    b.set(com, 2 + app.length);
    b.set(jpegHeader(2, 1).slice(2), 2 + app.length * 2);
    expect(() => jpeg(b)).not.toThrow();
  });
  it("bounds fill-marker work", () => {
    const b = new Uint8Array(65540).fill(255);
    b.set([255, 216]);
    expect(() => jpeg(b)).toThrowError("tooComplex");
  });
  it("checks precision,components and sampling", () => {
    for (const [at, value] of [
      [6, 12],
      [11, 0],
      [13, 0],
      [14, 4],
      [5, 10],
    ] as const) {
      const b = jpegHeader(1, 1);
      b[at] = value;
      expect(() => jpeg(b)).toThrowError("invalid");
    }
    expect(() =>
      jpeg(
        Uint8Array.from([
          255, 216, 255, 192, 0, 14, 8, 0, 1, 0, 1, 2, 1, 17, 0, 1, 17, 0,
        ]),
      ),
    ).toThrowError("invalid");
  });
  it.each([12, 16, 40, 52, 56, 64, 108, 124])("admits known DIB%i", (dib) => {
    expect(() => bitmap(bmp(2, 1, { dib }))).not.toThrow();
  });
  it.each([40, 52, 56, 108, 124])("keeps signed top-down DIB%i", (dib) => {
    expect(() => bitmap(bmp(2, -1, { dib }))).not.toThrow();
  });
  it.each([12, 16, 64])("does not reinterpret unsigned DIB%i height", (dib) => {
    expect(() =>
      bitmap(bmp(2, dib === 12 ? 65535 : 0xffffffff, { dib, dataBytes: 4 })),
    ).toThrowError("tooManyPixels");
  });
  it.each([1, 4, 8, 24])("admits CORE bitdepth%i", (bits) => {
    expect(() => bitmap(bmp(2, 1, { dib: 12, bits }))).not.toThrow();
  });
  it.each([1, 4, 8, 16, 24, 32])("admits Windows RGB bitdepth%i", (bits) => {
    expect(() => bitmap(bmp(2, 1, { bits }))).not.toThrow();
  });
  it.each([
    [1, 8],
    [2, 4],
    [3, 16],
    [6, 32],
  ] as const)(
    "admits Windows compression%i/bpp%i declaration",
    (compression, bits) => {
      expect(() =>
        bitmap(
          bmp(2, 1, {
            compression,
            bits,
            dataBytes: compression === 6 ? 8 : 4,
          }),
        ),
      ).not.toThrow();
    },
  );
  it.each([
    [3, 1],
    [4, 24],
  ] as const)("distinguishes OS2 compression%i/bpp%i", (compression, bits) => {
    expect(() =>
      bitmap(bmp(2, 1, { dib: 64, compression, bits, dataBytes: 4 })),
    ).not.toThrow();
  });
  it("rejects negative width,zero and huge signed absolute height", () => {
    expect(() => bitmap(bmp(-1, 1, { dataBytes: 4 }))).toThrowError("invalid");
    expect(() => bitmap(bmp(0, 1, { dataBytes: 4 }))).toThrowError("invalid");
    expect(() => bitmap(bmp(1, 0, { dataBytes: 4 }))).toThrowError("invalid");
    expect(() => bitmap(bmp(1, 0x80000000, { dataBytes: 4 }))).toThrowError(
      "tooManyPixels",
    );
    expect(() => bitmap(bmp(8193, 1, { dataBytes: 4 }))).toThrowError(
      "tooManyPixels",
    );
  });
  it("checks byte lengths,offset,palette and reserved fields", () => {
    const b = bmp();
    for (const [at, val] of [
      [2, 0],
      [2, b.length + 1],
      [10, 20],
      [10, b.length],
      [6, 1],
      [8, 1],
    ] as const)
      expect(() => bitmap(set32(b, at, val))).toThrowError("invalid");
    expect(() => bitmap(set32(bmp(2, 1, { bits: 1 }), 10, 54))).toThrowError(
      "invalid",
    );
    expect(() => bitmap(set32(bmp(2, 1, { bits: 1 }), 46, 3))).toThrowError(
      "invalid",
    );
    expect(() => bitmap(set32(bmp(), 34, 1000))).toThrowError("invalid");
    expect(() => bitmap(bmp(2, 2, { dataBytes: 4 }))).toThrowError("invalid");
  });
  it("rejects unsupported compression and wrong family/bitdepth", () => {
    for (const [dib, compression, bits] of [
      [40, 4, 24],
      [40, 5, 24],
      [40, 1, 24],
      [40, 3, 8],
      [12, 0, 16],
      [64, 3, 24],
      [64, 4, 1],
    ] as const)
      expect(() =>
        bitmap(bmp(2, 1, { dib, compression, bits, dataBytes: 4 })),
      ).toThrowError("invalid");
    expect(() =>
      bitmap(bmp(2, -1, { compression: 1, bits: 8, dataBytes: 4 })),
    ).toThrowError("invalid");
    expect(() =>
      bitmap(
        bmp(2, 1, { compression: 1, bits: 8, dataBytes: 4, imageBytes: 0 }),
      ),
    ).toThrowError("invalid");
  });
  it("requires planes1,known DIB and BM signature", () => {
    const b = bmp(),
      p = b.slice();
    p[26] = 2;
    expect(() => bitmap(p)).toThrowError("invalid");
    expect(() => bitmap(set32(b, 14, 20))).toThrowError("invalid");
    b[0] = 0;
    expect(() => bitmap(b)).toThrowError("invalid");
  });
});
