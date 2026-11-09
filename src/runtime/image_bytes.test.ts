import { constants, crc32, deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  IMAGE_BYTES_STRINGS as S,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  inspectImageBytes,
  sniffImageMime,
} from "./image_bytes";

// Existing Pillow encoded these tiny, generated pixels in memory. These are
// real codec files, not claims that a browser or an Agent decoded them.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";
// Exact bytes of the 160×100 test PNG that WebKit decoded as a black rectangle.
const PNG_RESERVED_DEFLATE =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAAB0lEQVR4nAcAAAABOVJ/1gAAAABJRU5ErkJggg==";
const JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDDh/1Ef+6P5UUUV+iYX+BD0X5HxGP/AN7q/wCKX5s//9k=";
const GIF = "R0lGODdhAgABAIEAAP8AAACA/wAAAAAAACwAAAAAAgABAAAIBQABBAgIADs=";
const WEBP =
  "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAEAAUAmJYgCdLoAAwkG/ewA/upGnauhvUjDF/H/R9cIsgIAAA==";
const WEBP_LOSSLESS = "UklGRhwAAABXRUJQVlA4TA8AAAAvAQAAAAcQ/Y/+ByKi/wEA";
const WEBP_EXTENDED =
  "UklGRloAAABXRUJQVlA4WAoAAAAQAAAAAQAAAAAAQUxQSAMAAAAAgP8AVlA4IDAAAADQAQCdASoCAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=";
const JPEG_PROGRESSIVE =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABigy4/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";
const APNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAQAAAAAAAAAAAGQD6AAAECjlZAAAAAxJREFUeJxj/M8AAgAGCAEBWs8GSAAAABpmY1RMAAAAAQAAAAIAAAABAAAAAAAAAAAAZAPoAACLWw+wAAAAE2ZkQVQAAAACeJxjZGj4z8DAAAAGigGBHdUz0wAAAABJRU5ErkJggg==";
const GIF_ANIMATED =
  "R0lGODlhAgABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAAIBQABAAgIACH5BAEKAAEALAAAAAACAAEAgQCA/wAAAAAAAAAAAAgFAAEACAgAOw==";
const WEBP_ANIMATED =
  "UklGRsoAAABXRUJQVlA4WAoAAAACAAAAAQAAAAAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAAAAGQAAAJWUDggMgAAADABAJ0BKgIAAQABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkwAAAAAAAAAAAABAAAAAABkAAAAVlA4IDQAAAA0AQCdASoCAAEAAAAmJaAAA3AA/uxw3//72C//3Gf//cZ/9bv//27P//cgH/9yAftLAAAA";

const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const fixtures = [
  [PNG, "image/png"],
  [JPEG, "image/jpeg"],
  [GIF, "image/gif"],
  [WEBP, "image/webp"],
  [WEBP_LOSSLESS, "image/webp"],
  [WEBP_EXTENDED, "image/webp"],
  [JPEG_PROGRESSIVE, "image/jpeg"],
] as const;

it.each(fixtures)(
  "identifies and bounds real static fixture %#",
  (file, mimeType) => {
    expect(sniffImageMime(bytes(file))).toBe(mimeType);
    expect(inspectImageBytes(bytes(file))).toEqual({
      mimeType,
      width: 2,
      height: 1,
    });
  },
);

it("does not recognize SVG, text, empty bytes or a partial signature", () => {
  for (const input of [
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    new TextEncoder().encode("image/png"),
    new Uint8Array(),
    bytes(PNG).slice(0, 7),
  ]) {
    expect(sniffImageMime(input)).toBeNull();
    expect(() => inspectImageBytes(input)).toThrow(S.invalid);
  }
});

it("sniffing a recognized signature is insufficient to accept a header-only file", () => {
  for (const [file] of fixtures.slice(0, 4)) {
    const full = bytes(file);
    const header = full.slice(0, file === GIF ? 13 : 20);
    expect(sniffImageMime(header)).not.toBeNull();
    expect(() => inspectImageBytes(header)).toThrow(S.invalid);
  }
});

it("rejects unfinished containers and trailing bytes without exposing their input", () => {
  for (const [file] of fixtures.slice(0, 4)) {
    const full = bytes(file);
    for (const broken of [full.slice(0, -1), new Uint8Array([...full, 0])])
      expect(() => inspectImageBytes(broken)).toThrow(S.invalid);
  }
});

it("rejects compressed byte size before accepting a signature", () => {
  const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
  oversized.set(bytes(PNG));
  expect(() => inspectImageBytes(oversized)).toThrow(S.tooLarge);
});

it.each([APNG, GIF_ANIMATED, WEBP_ANIMATED])(
  "rejects animation rather than trusting only its small canvas",
  (file) => expect(() => inspectImageBytes(bytes(file))).toThrow(S.animated),
);

function pngDimensions(width: number, height: number) {
  const input = bytes(PNG);
  const view = new DataView(input.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(input.subarray(12, 29)));
  return input;
}

it("checks nonzero dimensions, each edge and the pixel product before decoding", () => {
  expect(() => inspectImageBytes(pngDimensions(0, 1))).toThrow(S.invalid);
  expect(() => inspectImageBytes(pngDimensions(MAX_IMAGE_EDGE + 1, 1))).toThrow(
    S.tooManyPixels,
  );
  expect(() =>
    inspectImageBytes(
      pngDimensions(MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS / MAX_IMAGE_EDGE + 1),
    ),
  ).toThrow(S.tooManyPixels);
  expect(
    inspectImageBytes(
      pngDimensions(MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS / MAX_IMAGE_EDGE),
    ).width,
  ).toBe(MAX_IMAGE_EDGE);
});

it("rejects corrupt PNG chunks even when its dimensions and magic look valid", () => {
  const badCrc = bytes(PNG);
  badCrc[badCrc.length - 5] ^= 1;
  expect(() => inspectImageBytes(badCrc)).toThrow(S.invalid);
  const noImage = new Uint8Array([
    ...bytes(PNG).slice(0, 33),
    ...bytes(PNG).slice(-12),
  ]);
  expect(() => inspectImageBytes(noImage)).toThrow(S.invalid);
});

function pngWithSplitIdat(template: Uint8Array, compressed: Uint8Array) {
  const parts = [
    new Uint8Array(),
    compressed.subarray(0, 1),
    compressed.subarray(1, 2),
    new Uint8Array(),
    compressed.subarray(2, 3),
    compressed.subarray(3),
  ];
  const chunks = parts.map((part) => {
    const kindAndData = Buffer.concat([Buffer.from("IDAT"), part]);
    const chunk = Buffer.alloc(kindAndData.length + 8);
    chunk.writeUInt32BE(part.length);
    chunk.set(kindAndData, 4);
    chunk.writeUInt32BE(crc32(kindAndData), chunk.length - 4);
    return chunk;
  });
  return new Uint8Array(
    Buffer.concat([
      template.subarray(0, 33),
      ...chunks,
      template.subarray(-12),
    ]),
  );
}

it.each([false, true])(
  "rejects a reserved first PNG DEFLATE block (split IDAT: %s)",
  (split) => {
    const original = bytes(PNG_RESERVED_DEFLATE);
    const input = split
      ? pngWithSplitIdat(original, original.subarray(41, 48))
      : original;
    expect(() => inspectImageBytes(input)).toThrow(S.invalid);
  },
);

it.each([
  [0, { level: 0 }],
  [1, { strategy: constants.Z_FIXED }],
  [2, { level: 9 }],
] as const)(
  "accepts PNG DEFLATE block type %i across IDAT chunks",
  (type, options) => {
    const scanlines = Buffer.alloc(100 * (1 + 160 * 3));
    const compressed = deflateSync(scanlines, options);
    expect((compressed[2] >>> 1) & 3).toBe(type);
    const input = pngWithSplitIdat(bytes(PNG_RESERVED_DEFLATE), compressed);
    expect(inspectImageBytes(input)).toEqual({
      mimeType: "image/png",
      width: 160,
      height: 100,
    });
  },
);

function jpegFrame(input: Uint8Array) {
  return input.findIndex(
    (value, index) => value === 0xff && input[index + 1] === 0xc0,
  );
}

it("requires an 8-bit supported JPEG frame and rejects deferred height markers", () => {
  const original = bytes(JPEG);
  const frame = jpegFrame(original);
  const precision = original.slice();
  precision[frame + 4] = 12;
  const unsupported = original.slice();
  unsupported[frame + 1] = 0xc3;
  const zeroHeight = original.slice();
  zeroHeight[frame + 5] = zeroHeight[frame + 6] = 0;
  const dnl = new Uint8Array([
    ...original.slice(0, -2),
    0xff,
    0xdc,
    0,
    4,
    0,
    1,
    0xff,
    0xd9,
  ]);
  for (const input of [precision, unsupported, zeroHeight, dnl])
    expect(() => inspectImageBytes(input)).toThrow(S.invalid);
});

it("rejects an oversized GIF image descriptor inside a small logical screen", () => {
  const input = bytes(GIF);
  const descriptor = input.indexOf(0x2c, 13);
  input[descriptor + 5] = 0xff;
  input[descriptor + 6] = 0xff;
  expect(() => inspectImageBytes(input)).toThrow();
});

it("finds a second GIF descriptor even without a looping extension", () => {
  const input = bytes(GIF_ANIMATED);
  const app = input.indexOf(0x21, 13);
  const noLoopExtension = new Uint8Array([
    ...input.slice(0, app),
    ...input.slice(app + 19),
  ]);
  expect(() => inspectImageBytes(noLoopExtension)).toThrow(S.animated);
});

it("checks the WebP codec dimensions before accepting its smaller VP8X canvas", () => {
  const input = bytes(WEBP_EXTENDED);
  const chunk = Buffer.from(input).indexOf("VP8 ", 30);
  new DataView(input.buffer).setUint16(chunk + 8 + 6, MAX_IMAGE_EDGE + 1, true);
  expect(() => inspectImageBytes(input)).toThrow(S.tooManyPixels);
});

it("rejects contradictory WebP canvas or chunk lengths", () => {
  const canvas = bytes(WEBP_EXTENDED);
  canvas[24] = 2; // Three-pixel VP8X canvas, two-pixel VP8 payload.
  const chunk = bytes(WEBP);
  new DataView(chunk.buffer).setUint32(16, 0xfffffff0, true);
  for (const input of [canvas, chunk])
    expect(() => inspectImageBytes(input)).toThrow(S.invalid);
});
