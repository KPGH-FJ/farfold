import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { messageAudioAdmission } from "./message_audio_admission";
import {
  waveTestRiff,
  type WaveTestChunk,
} from "./message_audio_fixtures.test-support";

/** Owned zero-predictor/index/nibble IMA blocks. The SHA-identified mono
 * short/long/exact-600 files were independently decoded by macOS afconvert;
 * mutations, stereo, tails and synthetic clock boundaries below are only
 * structural/declaration controls, not additional native/playback evidence. */
function imaWave({
  blocks = 64,
  channels = 1,
  sampleRate = 8000,
  align = 256 * channels,
  samplesPerBlock = 505,
  bits = 4,
  format = 0x11,
  fmtLength = 20,
  extra = 2,
  byteRate = Math.floor((sampleRate * align) / samplesPerBlock),
  factFrames = blocks * samplesPerBlock,
  partialBytes = 0,
  before = [],
  after = [],
}: {
  blocks?: number;
  channels?: number;
  sampleRate?: number;
  align?: number;
  samplesPerBlock?: number;
  bits?: number;
  format?: number;
  fmtLength?: number;
  extra?: number;
  byteRate?: number;
  factFrames?: number;
  partialBytes?: number;
  before?: readonly WaveTestChunk[];
  after?: readonly WaveTestChunk[];
} = {}): Buffer {
  const fmt = Buffer.alloc(fmtLength);
  fmt.writeUInt16LE(format, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(align, 12);
  fmt.writeUInt16LE(bits, 14);
  fmt.writeUInt16LE(extra, 16);
  fmt.writeUInt16LE(samplesPerBlock, 18);
  const fact = Buffer.alloc(4);
  fact.writeUInt32LE(factFrames);
  return waveTestRiff([
    { kind: "fmt ", data: fmt },
    { kind: "fact", data: fact },
    ...before,
    { kind: "data", data: Buffer.alloc(blocks * align + partialBytes) },
    ...after,
  ]);
}

const short = imaWave();
const long = imaWave({ blocks: 9521 });
const exact600 = imaWave({ blocks: 9600, sampleRate: 8080 });

it.each([
  {
    label: "4.04-second short",
    bytes: short,
    sha: "b8531adda531dc38f21697d7acfc726e456a5999c3ad012bedc33e4622623e94",
  },
  {
    label: "601.013125-second long",
    bytes: long,
    sha: "26ef6613798d22032b083cf2d2c47652f329662195c77567d0061440cece326d",
  },
  {
    label: "genuine exact-600-second",
    bytes: exact600,
    sha: "f364aef5c536bbbf198c45df7381cbdda68a0caed4c6858a3d7053a5965b0249",
  },
])(
  "reconstructs the complete independently decoded $label file",
  ({ bytes, sha }) => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  },
);

it.each([
  { label: "short", bytes: short },
  { label: "genuine exact 600 seconds", bytes: exact600 },
])(
  "keeps $label bytes available without certifying exact IMA duration",
  ({ bytes }) => {
    const data = bytes.toString("base64");
    const uri = "fixture://owned/unchanged-ima.wav";
    const attachment = Object.freeze(
      normalizeMessageAttachment({
        type: "audio",
        mimeType: "audio/wav",
        data,
        uri,
      })!,
    );
    expect(messageAudioAdmission(data, "audio/wav")).toBe("notCovered");
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("available");
    if (result.status === "available")
      expect(result.media.src === `data:audio/wav;base64,${data}`).toBe(true);
    expect(attachment.data === data).toBe(true);
    expect(attachment.uri).toBe(uri);
  },
);

it("extends the known-prefix budget through the actual common preview entry", () => {
  const data = long.toString("base64");
  const attachment = Object.freeze({
    name: "original.wav",
    mimeType: "audio/wav",
    data,
  });
  // Independent from the direct parser assertion: old common admission really
  // returns available here. This is new recognition, not an old all-codec claim.
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("audioTooLong");
  expect(attachment.data === data).toBe(true);
});

it("extends the same budget through official embedded resource content", () => {
  const data = long.toString("base64");
  const uri = "fixture://owned/long-ima.wav";
  const attachment = Object.freeze(
    normalizeMessageAttachment({
      type: "resource",
      resource: { mimeType: "audio/wav", blob: data, uri },
    })!,
  );
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("audioTooLong");
  expect(attachment.data === data).toBe(true);
  expect(attachment.uri).toBe(uri);
});

it.each([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/aac",
])("checks the same complete long IMA signature under %s", (mimeType) => {
  const data = long.toString("base64");
  expect(
    attachmentMediaAdmission({ name: "original.wav", mimeType, data }),
  ).toEqual({
    status: "rejected",
    reason: "audioTooLong",
  });
});

it.each([0, 1, 0xffffffff])(
  "does not let fact=%i shorten the known long prefix",
  (factFrames) => {
    expect(
      messageAudioAdmission(
        imaWave({ blocks: 9521, factFrames }).toString("base64"),
        "audio/wav",
      ),
    ).toBe("audioTooLong");
  },
);

it.each([0, 1, 4055, 4056, 0xffffffff])(
  "does not treat byte-rate hint %i as linear sample size",
  (byteRate) => {
    expect(
      messageAudioAdmission(
        imaWave({ blocks: 9521, byteRate }).toString("base64"),
        "audio/wav",
      ),
    ).toBe("audioTooLong");
  },
);

it("does not divide the per-channel clock twice for selected stereo blocks", () => {
  expect(
    messageAudioAdmission(
      imaWave({ blocks: 9521, channels: 2 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});

it("keeps last-block padding near 600 seconds uncovered instead of falsely rejecting it", () => {
  // Capacity is 4800025 frames, but a valid fact can describe a padded last
  // block. CoreAudio ignored these fact values; other consumers remain unknown.
  for (const factFrames of [4800000, 4800001]) {
    const bytes = imaWave({ blocks: 9505, factFrames });
    expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
      "notCovered",
    );
    expect(
      attachmentMediaAdmission({
        name: "boundary.wav",
        mimeType: "audio/wav",
        data: bytes.toString("base64"),
      }).status,
    ).toBe("available");
  }
});

it("uses a strict greater-than boundary for a synthetic complete prefix clock", () => {
  // Header-only 4-byte blocks are a declaration boundary, not native evidence.
  expect(
    messageAudioAdmission(
      imaWave({
        blocks: 601,
        sampleRate: 1,
        align: 4,
        samplesPerBlock: 1,
      }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("notCovered");
  expect(
    messageAudioAdmission(
      imaWave({
        blocks: 602,
        sampleRate: 1,
        align: 4,
        samplesPerBlock: 1,
      }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});

it("preserves partial-tail compatibility without hiding an independently long complete prefix", () => {
  expect(
    messageAudioAdmission(
      imaWave({ partialBytes: 1 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("notCovered");
  expect(
    messageAudioAdmission(
      imaWave({ blocks: 9521, partialBytes: 1 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});

it("does not turn the ignored header-only tail candidate into exact-duration proof", () => {
  const bytes = imaWave({
    blocks: 9600,
    sampleRate: 8080,
    factFrames: 4848001,
    partialBytes: 4,
  });
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "e320196966ca44f7c684036c8f205c5e531e841034d4c36a401d73eb2b85bbb9",
  );
  expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
    "notCovered",
  );
});

it("retains the same independent prefix limit in a playlist-bearing file", () => {
  expect(
    messageAudioAdmission(
      imaWave({
        blocks: 9521,
        after: [{ kind: "plst", data: Buffer.alloc(0) }],
      }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});

it.each([
  { label: "zero sample rate", overrides: { sampleRate: 0 } },
  { label: "zero block alignment", overrides: { align: 0 } },
  { label: "incomplete channel word groups", overrides: { align: 257 } },
  {
    label: "inconsistent samples per block",
    overrides: { samplesPerBlock: 504 },
  },
])("rejects selected-layout $label", ({ overrides }) => {
  expect(
    messageAudioAdmission(imaWave(overrides).toString("base64"), "audio/wav"),
  ).toBe("invalid");
});

it.each([
  {
    label: "additional extension bytes",
    overrides: { fmtLength: 22, extra: 4 },
  },
  { label: "different extension layout", overrides: { extra: 0 } },
  { label: "other IMA bit packing", overrides: { bits: 3 } },
  { label: "unselected channel layout", overrides: { channels: 3 } },
  { label: "other compressed tag", overrides: { format: 2 } },
])("preserves uncovered $label", ({ overrides }) => {
  expect(
    messageAudioAdmission(
      imaWave({ blocks: 9521, ...overrides }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("notCovered");
});
