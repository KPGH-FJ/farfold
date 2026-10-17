import { expect, it, vi } from "vitest";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_RASTER_TEST_DATA as F } from "./message_raster_fixtures.test-support";
import { AUDIO_FIXTURE_DATA } from "./audio_input.test-support";

const source = (data: string, mimeType: string) => ({
  kind: "image" as const,
  name: "Preserved raster",
  uri: "file:///owned/source.image",
  data,
  mimeType,
});

it.each([
  ["image/jpeg", F.JPEG],
  ["image/jpeg", F.JPEG_PROGRESSIVE],
  ["image/gif", F.GIF],
  ["image/gif", F.GIF_ANIMATED],
  ["image/webp", F.WEBP],
  ["image/webp", F.WEBP_LOSSLESS],
  ["image/webp", F.WEBP_EXTENDED],
  ["image/webp", F.WEBP_ANIMATED],
])(
  "retains the exact bounded static or animated codec fixture %#",
  (mime, data) => {
    const attachment = source(data, mime);
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "available",
      media: { kind: "image", src: `data:${mime};base64,${data}` },
    });
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

const oversized = () => {
  const jpeg = Buffer.from(F.JPEG, "base64");
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  if (frame < 0) throw new Error("owned fixture missing SOF");
  jpeg.writeUInt16BE(8193, frame + 7);
  const gif = Buffer.from(F.GIF, "base64");
  gif.writeUInt16LE(8193, 6);
  const webp = Buffer.from(F.WEBP, "base64");
  webp.writeUInt16LE(8193, 26);
  return [jpeg, gif, webp].map((bytes) => bytes.toString("base64"));
};

it.each(["image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"])(
  "does not bypass actual-signature canvas limits under %s",
  (mime) => {
    for (const data of oversized()) {
      const attachment = source(data, mime);
      const before = JSON.stringify(attachment);
      expect(attachmentMediaAdmission(attachment)).toEqual({
        status: "rejected",
        reason: "tooManyPixels",
      });
      expect(JSON.stringify(attachment)).toBe(before);
    }
  },
);

it.each(["image/jpeg", "image/gif", "image/webp", "image/bmp"])(
  "refuses unknown or truncated declared %s before URL creation",
  (mime) => {
    expect(attachmentMediaAdmission(source("YWJj", mime))).toEqual({
      status: "rejected",
      reason: "invalid",
    });
  },
);

it("does not fully decode the Base64 while checking the raster structure", () => {
  const decode = vi.spyOn(globalThis, "atob");
  try {
    expect(
      attachmentMediaAdmission(source(F.GIF_ANIMATED, "image/gif")).status,
    ).toBe("available");
    // The pre-existing PNG signature/IHDR gate reads at most33 decoded bytes.
    expect(decode.mock.calls).toEqual([[F.GIF_ANIMATED.slice(0, 44)]]);
  } finally {
    decode.mockRestore();
  }
});

it("retains prior byte/encoding precedence and does not route audio into raster parsing", () => {
  const decode = vi.spyOn(globalThis, "atob");
  try {
    for (const data of ["!".repeat(44), "Zh==", "Zg"])
      expect(attachmentMediaAdmission(source(data, "image/gif"))).toEqual({
        status: "rejected",
        reason: "invalid",
      });
    expect(
      attachmentMediaAdmission(source(AUDIO_FIXTURE_DATA, "audio/wav")),
    ).toEqual({
      status: "available",
      media: {
        kind: "audio",
        src: `data:audio/wav;base64,${AUDIO_FIXTURE_DATA}`,
      },
    });
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});

it("returns a refusal for bounded malformed structures rather than throwing or mutating payloads", () => {
  const signatures = [
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
    ["image/bmp", Buffer.from("BM")],
  ] as const;
  let seed = 0x51d73a;
  for (const [mime, signature] of signatures) {
    for (let iteration = 0; iteration < 256; iteration++) {
      const bytes = Buffer.alloc(signature.length + (iteration % 193));
      for (let at = 0; at < bytes.length; at++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        bytes[at] = seed >>> 24;
      }
      signature.copy(bytes);
      const data = bytes.toString("base64");
      const attachment = source(data, mime);
      const result = attachmentMediaAdmission(attachment);
      expect(result.status).toBe("rejected");
      expect(attachment.data).toBe(data);
    }
  }
});
