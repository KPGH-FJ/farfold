import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  attachmentMedia,
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { messageFlacAdmission } from "./message_flac_admission";
import {
  MESSAGE_FLAC_TEST_DATA,
  flacTestFile,
} from "./message_flac_fixtures.test-support";
import { MessageRasterReader } from "./message_raster_reader";
import {
  SHORT_UNKNOWN_TOTAL,
  constantUnknownTotal,
  unknownTotal,
} from "./message_flac_unknown_total_fixtures.test-support";

const LONG = unknownTotal(MESSAGE_FLAC_TEST_DATA.LONG_601);
const sha = (data: string) =>
  createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
const input = (data: string, mimeType = "audio/flac") => ({
  kind: "audio" as const,
  name: "Owned public FLAC",
  uri: "file:///owned/public-control.flac",
  mimeType,
  data,
});

it("uses the same pinned unknown-total601s bytes as the captured native consumer", () => {
  expect(sha(LONG)).toBe(
    "8791e07f6bf0e0a10cad0de02dfbf587d2f2479e3149b4dfddba454c9b7fb968",
  );
  // This checks the production entry, not a future observer import or decoder.
  expect(messageFlacAdmission(LONG)).toBe("audioTooLong");
});

it.each(["audio/flac", "audio/wav"])(
  "refuses the known stored-frame lower bound before source creation under%s",
  (mimeType) => {
    const attachment = input(LONG, mimeType);
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "rejected",
      reason: "audioTooLong",
    });
    expect(attachmentMedia(attachment)).toBeNull();
    expect(JSON.stringify(attachment)).toBe(before);
  },
);

it("keeps the complete pinned2s nonconstant control available with its original source", () => {
  expect(sha(SHORT_UNKNOWN_TOTAL)).toBe(
    "3c48c657945298f67d82cc9e0af49bf01314d7acf924e0d501693acda369f0a0",
  );
  expect(messageFlacAdmission(SHORT_UNKNOWN_TOTAL)).toBe("notCovered");
  const attachment = input(SHORT_UNKNOWN_TOTAL);
  const before = JSON.stringify(attachment);
  expect(attachmentMediaAdmission(attachment)).toEqual({
    status: "available",
    media: {
      kind: "audio",
      src: `data:audio/flac;base64,${SHORT_UNKNOWN_TOTAL}`,
    },
  });
  expect(JSON.stringify(attachment)).toBe(before);
});

it("applies the same refusal to the official embedded-resource path without changing bytes", () => {
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/public-control.flac",
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
  "uses the existing600s boundary on constructed complete constant frames%s",
  (samples) => {
    // Structural policy controls; these new constructions are not native-decoder evidence.
    const data = constantUnknownTotal(samples);
    expect(messageFlacAdmission(data)).toBe(
      samples > 4_800_000 ? "audioTooLong" : "notCovered",
    );
    const admission = attachmentMediaAdmission(input(data));
    expect(admission.status).toBe(
      samples > 4_800_000 ? "rejected" : "available",
    );
    if (admission.status === "available")
      expect(admission.media.src).toBe(`data:audio/flac;base64,${data}`);
  },
);

it("does not let an unknown tail erase an already verified over-budget frame prefix", () => {
  const data = Buffer.concat([
    Buffer.from(constantUnknownTotal(4_800_001), "base64"),
    Buffer.from([0]),
  ]).toString("base64");
  expect(messageFlacAdmission(data)).toBe("audioTooLong");
});

it.each([47, 49])(
  "does not count a selected frame with damaged header/frame CRC byte%s",
  (offset) => {
    const damaged = Buffer.from(LONG, "base64");
    damaged[offset] ^= 1;
    expect(messageFlacAdmission(damaged.toString("base64"))).toBe("invalid");
  },
);

it("rejects duplicate/reordered frame numbers even when both frame CRCs are correct", () => {
  expect(
    messageFlacAdmission(constantUnknownTotal(8192, { duplicateSecond: true })),
  ).toBe("invalid");
});

it("shares metadata and frame accounting instead of granting a second65536-record budget", () => {
  const data = constantUnknownTotal(32, {
    blockSize: 16,
    paddingRecords: 65_534,
  });
  expect(messageFlacAdmission(data)).toBe("audioTooComplex");
});

it("does not let opaque reserved metadata exempt an independently known long frame prefix", () => {
  const audio = Buffer.from(LONG, "base64").subarray(42);
  const data = flacTestFile({
    totalSamples: 0,
    blocks: [{ type: 7, data: Buffer.alloc(0) }],
    audio,
  }).toString("base64");
  expect(messageFlacAdmission(data)).toBe("audioTooLong");
});

it("retains unknown-layout compatibility without a sync search or a duration success", () => {
  const data = flacTestFile({
    totalSamples: 0,
    audio: Buffer.from([0, 255, 248]),
  }).toString("base64");
  expect(messageFlacAdmission(data)).toBe("notCovered");
  expect(attachmentMediaAdmission(input(data)).status).toBe("available");
});

it("keeps nonzero declarations and zero-rate non-time-axis data on their original path", () => {
  expect(messageFlacAdmission(MESSAGE_FLAC_TEST_DATA.LONG_601)).toBe(
    "audioTooLong",
  );
  expect(messageFlacAdmission(MESSAGE_FLAC_TEST_DATA.TINY)).toBe(
    "withinBudget",
  );
  expect(
    messageFlacAdmission(
      flacTestFile({ totalSamples: 0, sampleRate: 0 }).toString("base64"),
    ),
  ).toBe("notCovered");
});

it("does not fully decode the accepted payload while observing the selected long frame prefix", () => {
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

it("retains the existing16MiB byte gate before any frame or metadata reads", () => {
  const read = vi.spyOn(MessageRasterReader.prototype, "u8");
  try {
    const data = "ZkxhQwAA" + "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3));
    expect(attachmentMediaAdmission(input(data))).toEqual({
      status: "rejected",
      reason: "tooLarge",
    });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});
