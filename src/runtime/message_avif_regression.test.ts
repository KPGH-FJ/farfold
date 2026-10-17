import { expect, it } from "vitest";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_AVIF_TEST_DATA as F } from "./message_avif_fixtures.test-support";

// Metadata mutations only. Never give an enlarged declaration to a decoder.
function mutate(
  source: string,
  type: string,
  afterType: number,
  value: number,
) {
  const bytes = Buffer.from(source, "base64");
  bytes.writeUInt32BE(value, bytes.indexOf(type) + afterType);
  return bytes;
}
function admit(bytes: Buffer) {
  return attachmentMediaAdmission({
    name: "Owned AVIF declaration",
    mimeType: "image/avif",
    uri: "file:///owned/image.avif",
    data: bytes.toString("base64"),
  });
}

it("rejects an AVIF ispe beyond the existing canvas edge before preview creation", () => {
  expect(admit(mutate(F.STATIC, "ispe", 8, 8193))).toEqual({
    status: "rejected",
    reason: "tooManyPixels",
  });
});

it("rejects an AVIF sequence declaring 129 samples instead of trusting its byte size", () => {
  expect(admit(mutate(F.SEQUENCE, "stsz", 12, 129))).toEqual({
    status: "rejected",
    reason: "tooComplex",
  });
});

it("does not let a small primary property hide an excessive later auxiliary/tile property", () => {
  const bytes = Buffer.from(F.ALPHA_GRID, "base64");
  bytes.writeUInt32BE(8193, bytes.lastIndexOf("ispe") + 8);
  expect(admit(bytes)).toEqual({ status: "rejected", reason: "tooManyPixels" });
});

it("does not silently admit an unbounded number of opaque BMFF boxes", () => {
  const original = Buffer.from(F.STATIC, "base64");
  const free = Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]);
  const bytes = Buffer.concat([
    original,
    ...Array.from({ length: 65_536 }, () => free),
  ]);
  expect(admit(bytes)).toEqual({ status: "rejected", reason: "tooComplex" });
});
