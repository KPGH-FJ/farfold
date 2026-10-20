import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { messageOggAudioAdmission as admit } from "./message_ogg_audio_admission";
import { attachmentMediaAdmission } from "./message_attachments";
import {
  oggTestPage as page,
  oggTestPackets as packets,
  oggTestHeaders as headers,
} from "./message_ogg_audio_fixtures.test-support";

const encode = (pages: Buffer[]) => Buffer.concat(pages).toString("base64");
// Declaration-only boundaries: no CRC or compressed codec validity claim.
function link(serial: number, samples = 2_400_001n, rate = 8000) {
  const origin = 1n << 50n;
  return [
    ...headers(serial, rate),
    page({
      serial,
      sequence: 2,
      granule: origin,
      ...packets([Buffer.from([0])]),
    }),
    page({
      serial,
      sequence: 3,
      flags: 4,
      granule: origin + samples,
      ...packets([Buffer.from([0])]),
    }),
  ];
}
function opusLink(serial: number, samples: bigint, preSkip: number) {
  const pages = link(serial, samples, 48000);
  const head = Buffer.alloc(19);
  head.write("OpusHead");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  pages[0] = page({ serial, flags: 2, ...packets([head]) });
  pages[1] = page({
    serial,
    sequence: 1,
    ...packets([Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)])]),
  });
  return pages;
}
it("subtracts each Opus link preSkip before summing at the exact threshold", () => {
  for (const [extra, expected] of [
    [0n, "notCovered"],
    [1n, "audioTooLong"],
  ] as const)
    expect(
      admit(
        encode([
          ...opusLink(1, 14_400_000n + 312n, 312),
          ...opusLink(2, 14_400_000n + 65535n + extra, 65535),
        ]),
      ),
    ).toBe(expected);
});
it("clamps an interval still inside preSkip without subtracting other links", () => {
  expect(
    admit(
      encode([
        ...opusLink(1, 1n, 65535),
        ...opusLink(2, 14_400_000n + 312n, 312),
        ...opusLink(3, 14_400_000n + 313n, 312),
      ]),
    ),
  ).toBe("audioTooLong");
});
it("does not sum different selected mappings even with the same clock", () => {
  expect(
    admit(
      encode([
        ...link(1, 14_400_001n, 48000),
        ...opusLink(2, 14_400_313n, 312),
      ]),
    ),
  ).toBe("notCovered");
});
it("adds only closed same-clock links and preserves exact 600s", () => {
  expect(admit(encode([...link(1, 2_400_000n), ...link(2, 2_400_000n)]))).toBe(
    "notCovered",
  );
  expect(admit(encode([...link(1), ...link(2, 2_400_000n)]))).toBe(
    "audioTooLong",
  );
  expect(admit(encode(link(1)))).toBe("notCovered");
});
it.each([
  "serial reuse",
  "parallel",
  "missing EOS",
  "missing BOS",
  "sequence",
  "continuation",
  "unknown mapping",
  "mixed clock",
  "unfinished",
  "empty EOS",
  "decreasing EOS",
  "extra BOS",
])("disables the new total for %s without guessing a duration", (fault) => {
  const a = link(1);
  const b = link(2);
  let pages = [...a, ...b];
  if (fault === "serial reuse") pages = [...a, ...link(1)];
  if (fault === "parallel") pages = [a[0], b[0], ...a.slice(1), ...b.slice(1)];
  if (fault === "missing EOS") a[3][5] = 0;
  if (fault === "missing BOS") b[0][5] = 0;
  if (fault === "sequence") b[3].writeUInt32LE(6, 18);
  if (fault === "continuation") b[3][5] |= 1;
  if (fault === "unknown mapping") b[0][29] = 0;
  if (fault === "mixed clock") b[0].writeUInt32LE(16000, 28 + 12);
  if (fault === "unfinished") b[3][5] = 0;
  if (fault === "empty EOS") {
    b[3][5] = 0;
    pages.push(page({ serial: 2, sequence: 4, flags: 4, granule: 0n }));
  }
  if (fault === "decreasing EOS") b[3].writeBigUInt64LE(0n, 6);
  if (fault === "extra BOS") pages.push(page({ serial: 3, flags: 2 }));
  expect(admit(encode(pages))).toBe("notCovered");
});
it("retains an independent known-long interval when a later chain is ineligible", () => {
  expect(admit(encode([...link(1, 4_800_001n), ...link(1)]))).toBe(
    "audioTooLong",
  );
});
it("does not reset the shared record budget at link boundaries", () => {
  const pages = [...link(1), ...link(2)];
  for (let sequence = 0; sequence < 65_536; sequence++)
    pages.push(page({ serial: 3, sequence }));
  expect(admit(encode(pages))).toBe("audioTooComplex");
});

function crc(bytes: Buffer): number {
  let value = 0;
  for (const byte of bytes) {
    value = (value ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++)
      value = ((value << 1) ^ (value & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  return value;
}
function realPrefix(serial: number): Buffer {
  const source = readFileSync(
    new URL("./fixtures/message-opus-long-610.opus", import.meta.url),
  );
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "2542a465a600eb9b4120be45970cb6a0e53c3a1535b152d09b09b20a706b4448",
  );
  const pages: Buffer[] = [];
  for (let at = 0; at < source.length;) {
    const count = source[at + 26];
    const length =
      27 +
      count +
      source.subarray(at + 27, at + 27 + count).reduce((a, b) => a + b, 0);
    const bytes = Buffer.from(source.subarray(at, at + length));
    const checksum = bytes.readUInt32LE(22);
    bytes.writeUInt32LE(0, 22);
    expect(crc(bytes)).toBe(checksum);
    bytes.writeUInt32LE(serial, 14);
    const last = bytes.readBigInt64LE(6) >= 306n * 48000n;
    if (last) bytes[5] |= 4;
    bytes.writeUInt32LE(crc(bytes), 22);
    pages.push(bytes);
    if (last) break;
    at += length;
  }
  expect(pages).toHaveLength(308);
  return Buffer.concat(pages);
}
it("rejects the real-packet two-link 609.987s lower bound before a media source", () => {
  // Complete page prefixes preserve codec packets, rewriting only serial/CRC/EOS.
  // The derived whole file has no new decoder or playback proof.
  const a = realPrefix(0x51000001);
  const b = realPrefix(0x51000002);
  const joined = Buffer.concat([a, b]);
  expect(createHash("sha256").update(joined).digest("hex")).toBe(
    "017e741156e47ae519c1823676f0a865af5d5070285ee471e8ea39c069d5c1b6",
  );
  expect(admit(a.toString("base64"))).toBe("notCovered");
  expect(admit(joined.toString("base64"))).toBe("audioTooLong");
  expect(
    attachmentMediaAdmission({
      kind: "audio",
      name: "two-link.opus",
      mimeType: "audio/ogg",
      data: joined.toString("base64"),
    }),
  ).toEqual({ status: "rejected", reason: "audioTooLong" });
});
