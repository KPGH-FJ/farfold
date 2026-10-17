import { expect, it, vi } from "vitest";
import {
  MessageRasterError,
  MessageRasterReader,
  rasterCanvas,
  rasterFrames,
  rasterRecord,
} from "./message_raster_reader";

it("reads canonical Base64 bytes at arbitrary positions without a full decode", () => {
  const decode = vi.spyOn(globalThis, "atob");
  try {
    for (const length of [1, 2, 3, 4, 255, 256, 257, 8191]) {
      const bytes = Buffer.alloc(length);
      for (let at = 0; at < length; at++) bytes[at] = (at * 131 + length) % 256;
      const reader = new MessageRasterReader(bytes.toString("base64"));
      expect(reader.length).toBe(length);
      for (let at = length - 1; at >= 0; at--)
        expect(reader.u8(at)).toBe(bytes[at]);
    }
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});

it("uses the byte sequence's endian values and explicit bounds", () => {
  const bytes = Buffer.from([0x12, 0x34, 0x56, 0x78, 0xff, 0xff, 0xff, 0xff]);
  const reader = new MessageRasterReader(bytes.toString("base64"));
  expect(reader.u16be(0)).toBe(0x1234);
  expect(reader.u16le(0)).toBe(0x3412);
  expect(reader.u24le(0)).toBe(0x563412);
  expect(reader.u32be(0)).toBe(0x12345678);
  expect(reader.u32le(0)).toBe(0x78563412);
  expect(reader.u32le(4)).toBe(0xffffffff);
  for (const at of [-1, 8, 0.5, NaN, Infinity])
    expect(() => reader.u8(at)).toThrow(MessageRasterError);
  expect(() => reader.u32be(5)).toThrow(MessageRasterError);
  expect(() => reader.require(0, -1)).toThrow(MessageRasterError);
  expect(() => reader.require(0, 9)).toThrow(MessageRasterError);
});

it("matches only an in-range signature", () => {
  const reader = new MessageRasterReader(
    Buffer.from("RIFFtestWEBP").toString("base64"),
  );
  expect(reader.matches(0, "RIFF")).toBe(true);
  expect(reader.matches(8, "WEBP")).toBe(true);
  expect(reader.matches(9, "WEBP")).toBe(false);
  expect(reader.matches(-1, "R")).toBe(false);
  expect(reader.matches(0, "GIF89a")).toBe(false);
});

it("admits declared limits and rejects dimensions or complexity beyond them", () => {
  expect(() => rasterCanvas(8192, 2048)).not.toThrow();
  for (const pair of [
    [8193, 1],
    [4096, 4097],
    [1, 0xffffffff],
  ])
    expect(() => rasterCanvas(pair[0], pair[1])).toThrow("tooManyPixels");
  for (const pair of [
    [0, 1],
    [1, -1],
    [0.5, 1],
    [NaN, 1],
  ])
    expect(() => rasterCanvas(pair[0], pair[1])).toThrow("invalid");
  expect(() => rasterFrames(512 * 1024, 128)).not.toThrow();
  expect(() => rasterFrames(512 * 1024, 129)).toThrow("tooComplex");
  expect(() => rasterFrames(16_777_216, 4)).not.toThrow();
  expect(() => rasterFrames(16_777_216, 5)).toThrow("tooComplex");
  expect(() => rasterRecord(65_536)).not.toThrow();
  expect(() => rasterRecord(65_537)).toThrow("tooComplex");
});
