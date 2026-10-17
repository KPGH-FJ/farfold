import { describe, expect, it } from "vitest";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_RASTER_TEST_DATA } from "./message_raster_fixtures.test-support";
import { messageWebpAdmission } from "./message_raster_webp";
import {
  MessageRasterError,
  MessageRasterReader,
  type MessageRasterRejection,
} from "./message_raster_reader";

const STATIC_WEBP = MESSAGE_RASTER_TEST_DATA.WEBP_LOSSLESS;
const ANIMATED_WEBP = MESSAGE_RASTER_TEST_DATA.WEBP_ANIMATED;

function riff(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
function chunks(data: Buffer): Buffer[] {
  const result: Buffer[] = [];
  for (let at = 12; at < data.length;) {
    const length = data.readUInt32LE(at + 4);
    result.push(data.subarray(at, at + 8 + length + (length & 1)));
    at += 8 + length + (length & 1);
  }
  return result;
}

it("rejects a tiny VP8L file declaring a canvas beyond the edge budget before media creation", () => {
  const file = Buffer.from(STATIC_WEBP, "base64");
  file.writeUInt32LE(8192, 21);
  expect(
    attachmentMediaAdmission({
      name: "large canvas",
      mimeType: "image/webp",
      data: file.toString("base64"),
    }),
  ).toMatchObject({ status: "rejected", reason: "tooManyPixels" });
});

it("rejects 129 small WebP animation frames instead of treating encoded bytes as a frame budget", () => {
  const original = chunks(Buffer.from(ANIMATED_WEBP, "base64"));
  const file = riff([
    original[0],
    original[1],
    ...Array.from({ length: 129 }, () => original[2]),
  ]);
  expect(
    attachmentMediaAdmission({
      name: "many frames",
      mimeType: "image/webp",
      data: file.toString("base64"),
    }),
  ).toMatchObject({ status: "rejected", reason: "tooComplex" });
});

function chunk(kind: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(kind);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)]);
}
function extended(width = 2, height = 1, flags = 0): Buffer {
  const body = Buffer.alloc(10);
  body[0] = flags;
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return chunk("VP8X", body);
}
function lossless(width = 2, height = 1): Buffer {
  const result = Buffer.from(chunks(Buffer.from(STATIC_WEBP, "base64"))[0]);
  result.writeUInt32LE(width - 1 + (height - 1) * 16_384, 9);
  return result;
}
function lossy(width = 2, height = 1): Buffer {
  const result = Buffer.from(
    chunks(Buffer.from(MESSAGE_RASTER_TEST_DATA.WEBP, "base64"))[0],
  );
  result.writeUInt16LE(width, 14);
  result.writeUInt16LE(height, 16);
  return result;
}
function animationFrame(
  width = 2,
  height = 1,
  x = 0,
  y = 0,
  parts: readonly Buffer[] = [lossless(width, height)],
): Buffer {
  const header = Buffer.alloc(16);
  header.writeUIntLE(x, 0, 3);
  header.writeUIntLE(y, 3, 3);
  header.writeUIntLE(width - 1, 6, 3);
  header.writeUIntLE(height - 1, 9, 3);
  // Duration 0 and loop count 0 are permitted: neither is a time bound.
  return chunk("ANMF", Buffer.concat([header, ...parts]));
}
function animation(
  width = 2,
  height = 1,
  count = 1,
  frame = animationFrame(),
): Buffer {
  return riff([
    extended(width, height, 2),
    chunk("ANIM", Buffer.alloc(6)),
    ...Array.from({ length: count }, () => frame),
  ]);
}
function inspect(file: Buffer): void {
  messageWebpAdmission(new MessageRasterReader(file.toString("base64")));
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

describe("WebP declarations without invoking a codec", () => {
  it.each(["WEBP", "WEBP_LOSSLESS", "WEBP_EXTENDED", "WEBP_ANIMATED"] as const)(
    "keeps the owned tiny Pillow %s fixture available",
    (kind) => {
      const data = MESSAGE_RASTER_TEST_DATA[kind];
      expect(() => inspect(Buffer.from(data, "base64"))).not.toThrow();
      expect(
        attachmentMediaAdmission({ name: kind, mimeType: "image/webp", data }),
      ).toMatchObject({ status: "available", media: { kind: "image" } });
    },
  );

  it.each([lossy, lossless])(
    "checks coded dimensions at exact edge/pixel limits",
    (image) => {
      expect(() => inspect(riff([image(8192, 2048)]))).not.toThrow();
      expect(() => inspect(riff([image(4096, 4096)]))).not.toThrow();
      rejection(riff([image(8193, 1)]), "tooManyPixels");
      rejection(riff([image(1, 8193)]), "tooManyPixels");
      rejection(riff([image(8192, 2049)]), "tooManyPixels");
    },
  );

  it("checks both the extended canvas and the actual coded frame", () => {
    expect(() => inspect(riff([extended(), lossless()]))).not.toThrow();
    rejection(riff([extended(8193), lossless()]), "tooManyPixels");
    rejection(riff([extended(), lossless(8193)]), "tooManyPixels");
    rejection(riff([extended(), lossy(8193)]), "tooManyPixels");
    rejection(riff([extended(), lossless(1)]));
    rejection(riff([extended(), lossy(1)]));
  });

  it("allows 128 frames and exactly 64M full-canvas frame pixels", () => {
    expect(() => inspect(animation(2, 1, 128))).not.toThrow();
    rejection(animation(2, 1, 129), "tooComplex");
    expect(() => inspect(animation(1024, 1024, 64))).not.toThrow();
    rejection(animation(1024, 1024, 65), "tooComplex");
    expect(() => inspect(animation(4096, 4096, 4))).not.toThrow();
    rejection(animation(4096, 4096, 5), "tooComplex");
  });

  it("checks every frame rectangle including doubled X/Y offsets", () => {
    expect(() =>
      inspect(animation(4, 3, 1, animationFrame(2, 1, 1, 1))),
    ).not.toThrow();
    rejection(animation(2, 1, 1, animationFrame(2, 1, 1)));
    rejection(animation(2, 1, 1, animationFrame(2, 1, 0, 1)));
    rejection(animation(2, 1, 1, animationFrame(3)));
    rejection(animation(2, 1, 1, animationFrame(8193)), "tooManyPixels");
    rejection(animation(2, 1, 1, animationFrame(2, 1, 0xffffff)));
  });

  it("checks dimensions of all nested VP8/VP8L frames, not only the outer VP8X/ANMF", () => {
    const parts = chunks(animation());
    for (const image of [lossy(8193), lossless(8193)])
      rejection(
        riff([...parts, animationFrame(2, 1, 0, 0, [image])]),
        "tooManyPixels",
      );
    rejection(animation(2, 1, 1, animationFrame(2, 1, 0, 0, [lossless(1)])));
    rejection(animation(2, 1, 1, animationFrame(2, 1, 0, 0, [lossy(1)])));
  });

  it("requires one ANIM before frames and no mixed static/animated reconstruction", () => {
    const parts = chunks(animation());
    rejection(riff([parts[0], parts[2]]));
    rejection(riff([parts[0], parts[2], parts[1]]));
    rejection(riff([parts[0], parts[1], parts[1], parts[2]]));
    rejection(riff([parts[0], parts[1]]));
    rejection(riff([parts[0], parts[1], lossless(), parts[2]]));
    rejection(riff([parts[0], parts[1], parts[2], lossless()]));
    rejection(riff([extended(), parts[1], parts[2]]));
    rejection(riff([parts[1], parts[2]]));
    rejection(riff([parts[0], chunk("ANIM", Buffer.alloc(5)), parts[2]]));
  });

  it("does not silently choose among duplicate reconstruction chunks", () => {
    rejection(riff([lossless(), lossy()]));
    rejection(riff([extended(), extended(), lossless()]));
    rejection(riff([lossless(), extended()]));
    rejection(
      animation(2, 1, 1, animationFrame(2, 1, 0, 0, [lossless(), lossy()])),
    );
    for (const kind of ["VP8X", "ANIM", "ANMF", "ICCP", "EXIF", "XMP "])
      rejection(
        animation(
          2,
          1,
          1,
          animationFrame(2, 1, 0, 0, [
            lossless(),
            chunk(kind, Buffer.alloc(0)),
          ]),
        ),
      );
  });

  it("supports ordered lossy alpha pairs in static and animated frames", () => {
    const alpha = chunk("ALPH", Buffer.from([0, 0x80, 0xff]));
    expect(() =>
      inspect(riff([extended(2, 1, 16), alpha, lossy()])),
    ).not.toThrow();
    const parts = [alpha, lossy()];
    expect(() =>
      inspect(
        riff([
          extended(2, 1, 18),
          chunk("ANIM", Buffer.alloc(6)),
          animationFrame(2, 1, 0, 0, parts),
        ]),
      ),
    ).not.toThrow();
    rejection(riff([extended(2, 1, 16), alpha, lossless()]));
    rejection(riff([extended(2, 1, 16), lossy(), alpha]));
    rejection(riff([extended(2, 1, 16), alpha, alpha, lossy()]));
    rejection(riff([extended(), alpha, lossy()]));
    rejection(riff([extended(2, 1, 16), lossy()]));
    rejection(animation(2, 1, 1, animationFrame(2, 1, 0, 0, parts)));
    for (const value of [0xc0, 2, 0x20])
      rejection(riff([extended(2, 1, 16), changed(alpha, 8, value), lossy()]));
  });

  it("keeps length-delimited metadata/unknown payloads opaque while checking metadata flags/order", () => {
    const exif = chunk("EXIF", Buffer.from("ANMFVP8XVP8L"));
    const icc = chunk("ICCP", Buffer.from([1]));
    const xmp = chunk("XMP ", Buffer.from([2]));
    const unknown = chunk("abcd", Buffer.from("ANMF"));
    expect(() =>
      inspect(riff([extended(2, 1, 44), exif, icc, unknown, lossless(), xmp])),
    ).not.toThrow();
    expect(() =>
      inspect(
        animation(
          2,
          1,
          1,
          animationFrame(2, 1, 0, 0, [unknown, lossless(), unknown]),
        ),
      ),
    ).not.toThrow();
    rejection(riff([extended(2, 1, 32), lossless(), icc]));
    rejection(riff([extended(), icc, lossless()]));
    rejection(riff([extended(2, 1, 32), lossless()]));
    rejection(riff([extended(2, 1, 8), exif, exif, lossless()]));
    rejection(riff([exif, lossless()]));
  });

  it("checks header, bitstream and frame reserved/version fields without decoding entropy", () => {
    for (const flags of [1, 64, 128])
      rejection(riff([extended(2, 1, flags), lossless()]));
    rejection(riff([changed(extended(), 9, 1), lossless()]));
    rejection(riff([changed(lossless(), 8, 0)]));
    rejection(riff([changed(lossless(), 12, 0xe0)]));
    rejection(riff([changed(lossy(), 8, 1)]));
    rejection(riff([changed(lossy(), 8, 0)]));
    rejection(riff([changed(lossy(), 11, 0)]));
    const hugePartition = lossy();
    hugePartition.fill(0xff, 9, 11);
    rejection(riff([hugePartition]));
    rejection(animation(2, 1, 1, changed(animationFrame(), 23, 4)));
  });

  it("counts all outer and nested chunks at the exact 65536 record limit", () => {
    const unknown = chunk("abcd", Buffer.alloc(0));
    expect(() =>
      inspect(
        riff([lossless(), ...Array.from({ length: 65_535 }, () => unknown)]),
      ),
    ).not.toThrow();
    rejection(
      riff([lossless(), ...Array.from({ length: 65_536 }, () => unknown)]),
      "tooComplex",
    );
    // VP8X + ANIM + ANMF + VP8L = 4 records, including the nested image chunk.
    const frame = (count: number) =>
      animationFrame(2, 1, 0, 0, [
        lossless(),
        ...Array.from({ length: count }, () => unknown),
      ]);
    expect(() => inspect(animation(2, 1, 1, frame(65_532)))).not.toThrow();
    rejection(animation(2, 1, 1, frame(65_533)), "tooComplex");
  });

  it("requires exact RIFF/chunk/nested lengths and zero odd padding", () => {
    const file = riff([lossless()]);
    for (const size of [0, 11, 12, 19, file.length - 1])
      rejection(file.subarray(0, size));
    rejection(changed(file, 4, 0));
    rejection(changed(file, 0, 0));
    rejection(Buffer.concat([file, Buffer.from([0, 0])]));
    const odd = chunk("abcd", Buffer.from([1]));
    rejection(riff([lossless(), changed(odd, odd.length - 1, 1)]));
    rejection(riff([lossless(), changed(odd, 4, 255)]));
    rejection(riff([chunk("abcd", Buffer.alloc(0))]));
    rejection(
      riff([changed(chunk("abcd", Buffer.alloc(0)), 0, 0), lossless()]),
    );
    const brokenNested = animationFrame();
    brokenNested.writeUInt32LE(1000, 28);
    rejection(animation(2, 1, 1, brokenNested));
  });
});
