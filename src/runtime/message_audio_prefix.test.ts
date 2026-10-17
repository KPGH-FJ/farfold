import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { messageAudioPrefix as prefix } from "./message_audio_prefix";
import {
  id3PrefixTestBytes as tag,
  MESSAGE_AUDIO_PREFIX_TEST_DATA as F,
} from "./message_audio_prefix_fixtures.test-support";
import { MessageRasterReader } from "./message_raster_reader";

const read = (bytes: Buffer) =>
  prefix(new MessageRasterReader(bytes.toString("base64")));

it.each(["", "ID", "opaqueID3", "RIFF", "fLaC", "\xff\xfb"])(
  "does not search%j for a later tag or audio header",
  (text) => {
    expect(read(Buffer.from(text, "binary"))).toEqual({
      status: "none",
      offset: 0,
      records: 0,
    });
  },
);

it.each([2, 3, 4])(
  "uses version%s stored body extent without copying it",
  (version) => {
    const bytes = tag({ version });
    expect(read(Buffer.concat([bytes, Buffer.from("opaque tail")]))).toEqual({
      status: "supported",
      offset: bytes.length,
      records: 1,
    });
  },
);

it("counts consecutive known leading tags without searching their contents", () => {
  const tags = [tag({ version: 2 }), tag(), tag({ version: 4, flags: 16 })];
  expect(read(Buffer.concat([...tags, Buffer.from("ID")]))).toEqual({
    status: "supported",
    offset: tags.reduce((size, part) => size + part.length, 0),
    records: 3,
  });
});

it.each([
  [
    "MPEG_LONG_601",
    3091859,
    "e665c760aef09b41c765a8d068bc9c34f28b9d2245538b173f2aee2775a41e34",
  ],
  [
    "MPEG_SHORT_3",
    16163,
    "4051945e3066c8c7181b46ee3138df5dec4aec296e95b794398f805d366e7394",
  ],
  [
    "MPEG_V22_SHORT_3",
    16159,
    "a52aa9c0a4feb838b6804db02acc284b3c9f3bcf1444cac45ba34ef031d3e869",
  ],
  [
    "MPEG_V24_FOOTER_SHORT_3",
    16173,
    "6972426971ce8a3dba135908ef3d8204a922bc6f1bbbc3a7cf8020e78f7e5220",
  ],
  [
    "ADTS_TINY",
    76,
    "3323d1a80f9d2661c59fb7e73797e84fc738afc38e57041a6d08bec2fbf05145",
  ],
  [
    "ADTS_LONG_601",
    51721,
    "0ebce0cd2261dedee69f14c8de9bf009d4a7aa8422f73d741398c4f176f8b848",
  ],
  [
    "ADTS_SHORT_65",
    5675,
    "e237cbc53002aae67ca8955dbda36b5115d0375320f867bc4de1e2ff71061478",
  ],
] as const)(
  "rebuilds complete independently decoded%s bytes exactly",
  (key, size, sha) => {
    const bytes = Buffer.from(F[key], "base64");
    expect(bytes.length).toBe(size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  },
);

it.each([
  { version: 0 },
  { version: 1 },
  { version: 5 },
  { revision: 1 },
  { version: 2, flags: 64 },
  { version: 2, flags: 1 },
  { version: 3, flags: 16 },
  { version: 4, flags: 8 },
])("keeps unknown or unimplemented outer flags%j uncovered", (options) => {
  expect(read(tag(options))).toEqual({ status: "notCovered" });
});

it.each([2, 3, 4])(
  "uses version%s stored unsynchronised extent, not a de-unsynchronised length",
  (version) => {
    const bytes = tag({
      version,
      flags: 128,
      body: Buffer.from([255, 0, 224]),
    });
    expect(read(bytes)).toEqual({
      status: "supported",
      offset: 13,
      records: 1,
    });
  },
);

it.each([3, 4, 5, 6, 7, 8, 9])(
  "rejects an identified known tag truncated to%s header bytes",
  (size) => {
    expect(read(tag().subarray(0, size))).toEqual({ status: "invalid" });
  },
);

it.each([6, 7, 8, 9])("rejects a non-synchsafe stored size byte%s", (index) => {
  const bytes = tag();
  bytes[index] |= 128;
  expect(read(bytes)).toEqual({ status: "invalid" });
});

it("requires the whole declared extent without a guessed recovery sync", () => {
  expect(read(tag({ declaredSize: 268435455 }))).toEqual({ status: "invalid" });
  expect(read(tag().subarray(0, -1))).toEqual({ status: "invalid" });
  expect(read(tag({ revision: 255 }))).toEqual({ status: "invalid" });
  expect(read(tag({ version: 255 }))).toEqual({ status: "invalid" });
});

it("requires and counts a matching v2.4 footer outside stored body size", () => {
  const bytes = tag({ version: 4, flags: 16 });
  expect(read(bytes)).toEqual({
    status: "supported",
    offset: bytes.length,
    records: 1,
  });
  expect(read(bytes.subarray(0, -1))).toEqual({ status: "invalid" });
  expect(read(tag({ version: 4, flags: 16, footer: false }))).toEqual({
    status: "invalid",
  });
});

it.each([0, 3, 4, 5, 6, 9])("rejects mismatching footer field%s", (field) => {
  const bytes = tag({ version: 4, flags: 16 });
  bytes[bytes.length - 10 + field] ^= 1;
  expect(read(bytes)).toEqual({ status: "invalid" });
});

it("bounds leading tag records without treating a zero-body variant as codec proof", () => {
  const part = tag({ body: Buffer.alloc(0) });
  const atLimit = Buffer.concat(Array(65536).fill(part));
  expect(read(atLimit)).toEqual({
    status: "supported",
    offset: atLimit.length,
    records: 65536,
  });
  expect(read(Buffer.concat([atLimit, part]))).toEqual({
    status: "audioTooComplex",
  });
});

it("jumps over a large stored body without reading metadata payload or allocating decoded audio", () => {
  const bytes = tag({ body: Buffer.alloc(16 * 1024 * 1024 - 10) });
  let reads = 0;
  const original = MessageRasterReader.prototype.u8;
  const spy = vi
    .spyOn(MessageRasterReader.prototype, "u8")
    .mockImplementation(function (this: MessageRasterReader, at) {
      reads++;
      return original.call(this, at);
    });
  const decoder = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw Error("No full decoded allocation");
  });
  try {
    expect(read(bytes)).toEqual({
      status: "supported",
      offset: bytes.length,
      records: 1,
    });
    expect(reads).toBeLessThan(24);
    expect(decoder).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    decoder.mockRestore();
  }
});
