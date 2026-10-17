import { describe, expect, it } from "vitest";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_RASTER_TEST_DATA } from "./message_raster_fixtures.test-support";
import { messageGifAdmission } from "./message_raster_gif";
import {
  MessageRasterError,
  MessageRasterReader,
  type MessageRasterRejection,
} from "./message_raster_reader";

const STATIC_GIF = MESSAGE_RASTER_TEST_DATA.GIF;

function gif(width = 2, height = 1, frames = 1): Buffer {
  const original = Buffer.from(STATIC_GIF, "base64");
  const head = Buffer.from(original.subarray(0, 25));
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  const frame = Buffer.from(original.subarray(25, -1));
  frame.writeUInt16LE(width, 5);
  frame.writeUInt16LE(height, 7);
  return Buffer.concat([
    head,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

it("rejects a tiny GIF container declaring a canvas beyond the edge budget before media creation", () => {
  const data = gif(8193).toString("base64");
  expect(
    attachmentMediaAdmission({
      name: "large canvas",
      mimeType: "image/gif",
      data,
    }),
  ).toMatchObject({ status: "rejected", reason: "tooManyPixels" });
});

it("rejects 129 small GIF frames instead of treating encoded bytes as a frame budget", () => {
  const data = gif(2, 1, 129).toString("base64");
  expect(
    attachmentMediaAdmission({
      name: "many frames",
      mimeType: "image/gif",
      data,
    }),
  ).toMatchObject({ status: "rejected", reason: "tooComplex" });
});

function inspect(file: Buffer): void {
  messageGifAdmission(new MessageRasterReader(file.toString("base64")));
}
function rejection(
  file: Buffer,
  reason: MessageRasterRejection = "invalid",
): void {
  expect(() => inspect(file)).toThrowError(MessageRasterError);
  expect(() => inspect(file)).toThrowError(reason);
}
function changed(file: Buffer, at: number, value: number): Buffer {
  const result = Buffer.from(file);
  result[at] = value;
  return result;
}
function beforeImage(blocks: readonly Buffer[]): Buffer {
  const file = gif();
  return Buffer.concat([file.subarray(0, 25), ...blocks, file.subarray(25)]);
}
function textGraphic(width = 2, height = 1): Buffer {
  const result = Buffer.alloc(16);
  result.set([0x21, 0x01, 12]);
  result.writeUInt16LE(width, 7);
  result.writeUInt16LE(height, 9);
  result.set([1, 1, 0, 1], 11);
  return result;
}

describe("GIF declarations without invoking a codec", () => {
  it.each(["GIF", "GIF_ANIMATED"] as const)(
    "keeps the owned tiny Pillow %s fixture available",
    (kind) => {
      const data = MESSAGE_RASTER_TEST_DATA[kind];
      expect(() => inspect(Buffer.from(data, "base64"))).not.toThrow();
      expect(
        attachmentMediaAdmission({ name: kind, mimeType: "image/gif", data }),
      ).toMatchObject({ status: "available", media: { kind: "image" } });
    },
  );

  it("admits the exact edge and pixel limits from headers, without decoding the synthetic raster", () => {
    expect(() => inspect(gif(8192, 2048))).not.toThrow();
    expect(() => inspect(gif(4096, 4096))).not.toThrow();
    rejection(gif(8192, 2049), "tooManyPixels");
    rejection(gif(8193, 1), "tooManyPixels");
    rejection(gif(1, 8193), "tooManyPixels");
    rejection(gif(0, 1));
  });

  it("admits 128 frames and bounds full-canvas work even when encoded rectangles are tiny", () => {
    expect(() => inspect(gif(2, 1, 128))).not.toThrow();
    rejection(gif(2, 1, 129), "tooComplex");
    const smallFrames = gif(2, 1, 64);
    smallFrames.writeUInt16LE(1024, 6);
    smallFrames.writeUInt16LE(1024, 8);
    expect(() => inspect(smallFrames)).not.toThrow();
    const excess = gif(2, 1, 65);
    excess.writeUInt16LE(1024, 6);
    excess.writeUInt16LE(1024, 8);
    rejection(excess, "tooComplex");
  });

  it("checks every later image descriptor, including offset and declared frame area", () => {
    const outside = gif(2, 1, 2);
    const second = 25 + (gif().length - 26);
    outside.writeUInt16LE(1, second + 1);
    rejection(outside);
    const hidden = gif(2, 1, 2);
    hidden.writeUInt16LE(8193, second + 5);
    rejection(hidden, "tooManyPixels");
    const below = gif(2, 1, 2);
    below.writeUInt16LE(1, second + 3);
    rejection(below);
  });

  it("requires a usable global or complete local palette", () => {
    const file = gif();
    const local = Buffer.concat([
      changed(file.subarray(0, 13), 10, 0),
      changed(file.subarray(25, 35), 9, 0x81),
      file.subarray(13, 25),
      file.subarray(35),
    ]);
    expect(() => inspect(local)).not.toThrow();
    const noPalette = Buffer.concat([
      changed(file.subarray(0, 13), 10, 0),
      file.subarray(25),
    ]);
    rejection(noPalette);
    rejection(file.subarray(0, 24));
    rejection(changed(file, 11, 4));
    rejection(changed(file, 34, 0x18));
  });

  it("walks length-delimited subblocks instead of scanning image bytes for frame markers", () => {
    const file = gif();
    file.fill(0x2c, 37, 42);
    expect(() => inspect(file)).not.toThrow();
    rejection(changed(gif(), 35, 1));
    rejection(changed(gif(), 35, 9));
    rejection(changed(gif(), 36, 255));
    const empty = Buffer.concat([
      gif().subarray(0, 36),
      Buffer.from([0, 0x3b]),
    ]);
    rejection(empty);
  });

  it("supports bounded comment, application, graphic-control and plain-text blocks", () => {
    const control = Buffer.from([0x21, 0xf9, 4, 0x0d, 0, 0, 0, 0]);
    const comment = Buffer.from([0x21, 0xfe, 3, 0x2c, 0x21, 0x3b, 0]);
    // The loop extension may request infinite replay; this is not a time limit.
    const loop = Buffer.concat([
      Buffer.from([0x21, 0xff, 11]),
      Buffer.from("NETSCAPE2.0"),
      Buffer.from([3, 1, 0, 0, 0]),
    ]);
    expect(() =>
      inspect(beforeImage([control, comment, loop, textGraphic()])),
    ).not.toThrow();
    rejection(beforeImage([changed(control, 3, 0x10)]));
    rejection(beforeImage([changed(control, 7, 1)]));
    rejection(beforeImage([changed(loop, 2, 10)]));
    rejection(beforeImage([changed(textGraphic(), 11, 0)]));
    rejection(beforeImage([textGraphic(3)]));
    rejection(beforeImage([Buffer.from([0x21, 0xf0, 0])]));
  });

  it("charges plain-text graphics as frames, even without an image descriptor", () => {
    const head = gif().subarray(0, 25);
    expect(() =>
      inspect(Buffer.concat([head, textGraphic(), Buffer.from([0x3b])])),
    ).not.toThrow();
    rejection(
      Buffer.concat([
        head,
        ...Array.from({ length: 129 }, () => textGraphic()),
        Buffer.from([0x3b]),
      ]),
      "tooComplex",
    );
  });

  it("bounds every data subblock and top-level record at the exact 65536 limit", () => {
    // Image + two image-data blocks + trailer = 4, comment + terminator = 2.
    const comment = (count: number) =>
      Buffer.concat([
        Buffer.from([0x21, 0xfe]),
        Buffer.from(Array.from({ length: count }, () => [1, 0x2c]).flat()),
        Buffer.from([0]),
      ]);
    expect(() => inspect(beforeImage([comment(65_530)]))).not.toThrow();
    rejection(beforeImage([comment(65_531)]), "tooComplex");
  });

  it("rejects short signatures, missing trailers, trailing bytes and unknown block kinds", () => {
    const file = gif();
    for (const length of [0, 5, 12, 24, 26, 34, 35, 37, file.length - 1])
      rejection(file.subarray(0, length));
    rejection(Buffer.concat([file, Buffer.from([0])]));
    rejection(changed(file, 0, 0));
    rejection(changed(file, 25, 0));
  });
});
