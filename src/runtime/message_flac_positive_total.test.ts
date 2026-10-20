import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { messageFlacAdmission } from "./message_flac_admission";
import {
  MESSAGE_FLAC_TEST_DATA as F,
  flacTestFile,
} from "./message_flac_fixtures.test-support";
import {
  constantUnknownTotal,
  SHORT_UNKNOWN_TOTAL,
  unknownTotal,
} from "./message_flac_unknown_total_fixtures.test-support";

// Change only the low36 total-sample bits. Frame bytes and all other declared
// properties stay exact. These conflicting declarations are policy controls,
// not valid-FLAC or elapsed-playback evidence.
function positiveTotal(data: string, samples = 1) {
  const bytes = Buffer.from(data, "base64");
  const mask = (1n << 36n) - 1n;
  bytes.writeBigUInt64BE(
    (bytes.readBigUInt64BE(18) & ~mask) | BigInt(samples),
    18,
  );
  return bytes.toString("base64");
}
const LONG = positiveTotal(F.LONG_601);
const input = (data: string, mimeType = "audio/flac") => ({
  kind: "audio" as const,
  name: "Owned FLAC control",
  data,
  mimeType,
});

it("does not let a short positive declaration hide the same verified long frame body", () => {
  const original = Buffer.from(F.LONG_601, "base64");
  const changed = Buffer.from(LONG, "base64");
  expect(
    [...changed.keys()].filter((at) => changed[at] !== original[at]),
  ).toEqual([23, 24, 25]);
  expect(changed.subarray(42)).toEqual(original.subarray(42));
  expect(createHash("sha256").update(changed).digest("hex")).toBe(
    "e03bfa879f0892f98e1fa548b5d8cd04b64222c3e07f9c62bc7d86611bd5ccf5",
  );
  for (const data of [F.LONG_601, unknownTotal(F.LONG_601), LONG])
    expect(messageFlacAdmission(data)).toBe("audioTooLong");
});

it.each(["audio/flac", "audio/wav", "audio/mpeg"])(
  "rejects the known long prefix before exposing an audio source under %s",
  (mimeType) => {
    const attachment = input(LONG, mimeType);
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "rejected",
      reason: "audioTooLong",
    });
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it("also rejects an embedded resource without changing its source bytes", () => {
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/control.flac",
      mimeType: "audio/flac",
      blob: LONG,
    },
  });
  expect(attachment).not.toBeNull();
  const before = JSON.stringify(attachment);
  expect(attachmentMediaAdmission(attachment!)).toEqual({
    status: "rejected",
    reason: "audioTooLong",
  });
  expect(JSON.stringify(attachment)).toBe(before);
});

it.each([4_800_000, 4_800_001])(
  "keeps the600s stored-frame boundary with a positive declaration: %s samples",
  (samples) => {
    const data = positiveTotal(constantUnknownTotal(samples));
    expect(messageFlacAdmission(data)).toBe(
      samples > 4_800_000 ? "audioTooLong" : "withinBudget",
    );
  },
);

it("retains short and nonconstant compatibility and the exact available source", () => {
  for (const data of [F.TINY, positiveTotal(SHORT_UNKNOWN_TOTAL)]) {
    expect(messageFlacAdmission(data)).toBe("withinBudget");
    expect(attachmentMediaAdmission(input(data))).toEqual({
      status: "available",
      media: { kind: "audio", src: `data:audio/flac;base64,${data}` },
    });
  }
});

it("keeps optional incomplete/damaged frame observations on the old positive metadata policy", () => {
  const damaged = Buffer.from(LONG, "base64");
  damaged[47] ^= 1;
  for (const data of [
    damaged.toString("base64"),
    flacTestFile({ totalSamples: 1, audio: Buffer.from([0]) }).toString(
      "base64",
    ),
    positiveTotal(constantUnknownTotal(8192, { duplicateSecond: true })),
  ])
    expect(messageFlacAdmission(data)).toBe("withinBudget");
  expect(messageFlacAdmission(unknownTotal(damaged.toString("base64")))).toBe(
    "invalid",
  );
});

it("does not grant the positive optional scan a fresh record budget or a new format restriction", () => {
  const data = positiveTotal(
    constantUnknownTotal(32, { blockSize: 16, paddingRecords: 65_534 }),
  );
  // The second frame exceeds the shared metadata+frame cap, so no independently
  // long prefix is proved. This intentionally retains the old positive policy.
  expect(messageFlacAdmission(data)).toBe("withinBudget");
  expect(messageFlacAdmission(unknownTotal(data))).toBe("audioTooComplex");
});

it("adds no full Base64 decoding while checking the positive long prefix", () => {
  const decode = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw new Error("unexpected full binary decode");
  });
  try {
    expect(attachmentMediaAdmission(input(LONG))).toEqual({
      status: "rejected",
      reason: "audioTooLong",
    });
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});
