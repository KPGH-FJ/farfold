import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { attachmentMediaAdmission } from "./message_attachments";
import { messageFlacAdmission } from "./message_flac_admission";
import { MESSAGE_FLAC_TEST_DATA as F } from "./message_flac_fixtures.test-support";
import { id3PrefixTestFile } from "./message_audio_prefix_fixtures.test-support";
import {
  id3PrefixTestBytes,
  MESSAGE_AUDIO_PREFIX_TEST_DATA as A,
} from "./message_audio_prefix_fixtures.test-support";

// Complete tagged 601-second control independently decoded without trimming
// the prefix, with every PCM byte equal to its bare control. This is not a
// promise that every FLAC decoder accepts this optional compatibility wrapper.
const completeLong = id3PrefixTestFile(F.LONG_601);

it("rebuilds the independently decoded complete tagged bytes exactly", () => {
  const bytes = Buffer.from(completeLong, "base64");
  expect(bytes.length).toBe(14047);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "97b4e2ccf1a3847bb26511bbce731a043e7d98c29f86da8c4077bab1ffc3304c",
  );
});

it("counts the independently decoded tagged FLAC duration", () => {
  expect(messageFlacAdmission(completeLong)).toBe("audioTooLong");
});

it("refuses the complete tagged FLAC through the unchanged common media entry", () => {
  expect(
    attachmentMediaAdmission({
      name: "Tagged FLAC",
      mimeType: "audio/flac",
      data: completeLong,
      uri: "file:///controlled/original-tagged.flac",
    }),
  ).toEqual({ status: "rejected", reason: "audioTooLong" });
});

it.each([
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/aac",
])("does not bypass a known tagged duration under %s", (mimeType) => {
  const input = {
    name: "Tagged FLAC",
    mimeType,
    data: completeLong,
    uri: "file:///controlled/original",
  };
  const before = JSON.stringify(input);
  expect(attachmentMediaAdmission(input)).toEqual({
    status: "rejected",
    reason: "audioTooLong",
  });
  expect(JSON.stringify(input)).toBe(before);
});

it.each([2, 3, 4])(
  "keeps original tagged bytes and STREAMINFO semantics for v%s",
  (version) => {
    // Declaration/byte-preservation checks only, not three decoder proofs.
    const data = id3PrefixTestFile(F.TINY, {
      version,
      flags: version === 4 ? 16 : 0,
    });
    expect(messageFlacAdmission(data)).toBe("withinBudget");
    expect(
      attachmentMediaAdmission({
        name: "Tagged FLAC",
        mimeType: "audio/flac",
        data,
      }),
    ).toEqual({
      status: "available",
      media: { kind: "audio", src: `data:audio/flac;base64,${data}` },
    });
  },
);

it("shares prefix and metadata record budgets without moving the required first STREAMINFO", () => {
  // Repeated zero-body tags exercise only stored extents; not codec validity.
  const tag = id3PrefixTestBytes({ body: Buffer.alloc(0) });
  const audio = Buffer.from(F.TINY, "base64");
  const atLimit = Buffer.concat([...Array(65535).fill(tag), audio]).toString(
    "base64",
  );
  const overLimit = Buffer.concat([...Array(65536).fill(tag), audio]).toString(
    "base64",
  );
  expect(messageFlacAdmission(atLimit)).toBe("withinBudget");
  expect(messageFlacAdmission(overLimit)).toBe("audioTooComplex");
  const duplicateInfo = Buffer.concat([
    id3PrefixTestBytes(),
    audio.subarray(0, 42),
    audio.subarray(4),
  ]);
  duplicateInfo[id3PrefixTestBytes().length + 4] = 0; // Clear first block's last bit.
  expect(messageFlacAdmission(duplicateInfo.toString("base64"))).toBe(
    "invalid",
  );
});

it("preserves non-FLAC continuation and bare FLAC behavior", () => {
  expect(messageFlacAdmission(A.MPEG_SHORT_3)).toBe("notFlac");
  expect(messageFlacAdmission(A.ADTS_SHORT_65)).toBe("notFlac");
  expect(messageFlacAdmission(F.TINY)).toBe("withinBudget");
  expect(messageFlacAdmission(F.LONG_601)).toBe("audioTooLong");
});

it("keeps unknown wrappers uncovered without searching later signatures", () => {
  expect(
    messageFlacAdmission(id3PrefixTestFile(F.LONG_601, { version: 5 })),
  ).toBe("notCovered");
  expect(
    messageFlacAdmission(
      id3PrefixTestFile(F.LONG_601, { version: 2, flags: 64 }),
    ),
  ).toBe("notCovered");
  expect(
    messageFlacAdmission(
      Buffer.concat([
        Buffer.from("opaque"),
        Buffer.from(completeLong, "base64"),
      ]).toString("base64"),
    ),
  ).toBe("notFlac");
});

it("rejects truncated known extents and malformed metadata at its declared boundary", () => {
  expect(
    messageFlacAdmission(Buffer.from("ID3\x03\0", "binary").toString("base64")),
  ).toBe("invalid");
  const body = Buffer.from(id3PrefixTestFile(F.TINY), "base64");
  body[43 + 4] = 0x81; // First FLAC block must be STREAMINFO, not padding.
  expect(messageFlacAdmission(body.toString("base64"))).toBe("invalid");
});
