import { expect, it } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import { MESSAGE_AVIF_TEST_DATA as F } from "./message_avif_fixtures.test-support";
import {
  avifBox as box,
  avifFile as file,
  avifTrack as track,
} from "./message_avif_builders.test-support";

it.each(["pict", "vide"])(
  "still checks the known %s display when its sample-description version is unknown",
  (handler) => {
    const bytes = Buffer.from(F.SEQUENCE, "base64");
    bytes[bytes.indexOf("stsd") + 4] = 2;
    bytes.write(handler, bytes.lastIndexOf("hdlr") + 12, "ascii");
    expect(messageAvifAdmission(bytes.toString("base64"), false)).toBe(
      "notCovered",
    );
    const head = bytes.indexOf("tkhd") - 4;
    bytes.writeUInt32BE(8193 * 65_536, head + bytes.readUInt32BE(head) - 8);
    expect(messageAvifAdmission(bytes.toString("base64"), false)).toBe(
      "tooManyPixels",
    );
  },
);

it.each(["pict", "vide"])(
  "still counts known %s display × samples when stsd is unknown",
  (handler) => {
    for (const count of [128, 129]) {
      const encoded = Buffer.from(
        file(box("moov", track(150, 150, count, { handler }))),
        "base64",
      );
      encoded[encoded.indexOf("stsd") + 4] = 2;
      expect(messageAvifAdmission(encoded.toString("base64"), false)).toBe(
        count > 128 ? "tooComplex" : "notCovered",
      );
    }
  },
);

it("does not impose picture display/frame counts on a known audio track", () => {
  const encoded = Buffer.from(
    file(box("moov", track(8193, 1, 129, { handler: "soun" }))),
    "base64",
  );
  encoded[encoded.indexOf("stsd") + 4] = 2;
  expect(messageAvifAdmission(encoded.toString("base64"), false)).toBe(
    "notCovered",
  );
});

it("does not reinterpret the tkhd aspect-ratio flag as a pixel declaration", () => {
  const encoded = Buffer.from(
    file(box("moov", track(1, 1, 1, { handler: "pict" }))),
    "base64",
  );
  const head = encoded.indexOf("tkhd") - 4;
  encoded[head + 11] |= 8;
  encoded.writeUInt32BE(8193 * 65_536, head + encoded.readUInt32BE(head) - 8);
  expect(messageAvifAdmission(encoded.toString("base64"), false)).toBe(
    "notCovered",
  );
});
