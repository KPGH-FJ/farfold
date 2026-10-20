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

const standardCoefficients = [
  [256, 0],
  [512, -256],
  [0, 0],
  [192, 64],
  [240, 0],
  [460, -208],
  [392, -232],
];

// Microsoft RIFFNEW(1994), printed pp22-24: tag2, seven bytes of block header
// per channel, then four-bit codes. Only the three SHA-identified mono files
// and the fact-one/padded controls were decoded by CoreAudio to PCM/EOF.
function msWave({
  blocks = 64,
  channels = 1,
  sampleRate = 8000,
  align = 256 * channels,
  samplesPerBlock = 500,
  bits = 4,
  coefficients = standardCoefficients,
  factFrames = blocks * samplesPerBlock,
  byteRate = Math.floor((sampleRate * align) / samplesPerBlock),
  partialBytes = 0,
  after = [],
}: {
  blocks?: number;
  channels?: number;
  sampleRate?: number;
  align?: number;
  samplesPerBlock?: number;
  bits?: number;
  coefficients?: number[][];
  factFrames?: number;
  byteRate?: number;
  partialBytes?: number;
  after?: readonly WaveTestChunk[];
} = {}): Buffer {
  const fmt = Buffer.alloc(22 + coefficients.length * 4);
  fmt.writeUInt16LE(2);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(align, 12);
  fmt.writeUInt16LE(bits, 14);
  fmt.writeUInt16LE(fmt.length - 18, 16);
  fmt.writeUInt16LE(samplesPerBlock, 18);
  fmt.writeUInt16LE(coefficients.length, 20);
  coefficients.forEach(([a, b], index) => {
    fmt.writeInt16LE(a, 22 + index * 4);
    fmt.writeInt16LE(b, 24 + index * 4);
  });
  const data = Buffer.alloc(blocks * align + partialBytes);
  if (align >= 7 * channels)
    for (let block = 0; block < blocks; block++) {
      for (let channel = 0; channel < channels; channel++)
        data.writeInt16LE(16, block * align + channels + channel * 2);
    }
  const fact = Buffer.alloc(4);
  fact.writeUInt32LE(factFrames);
  return waveTestRiff([
    { kind: "fmt ", data: fmt },
    { kind: "fact", data: fact },
    { kind: "data", data },
    ...after,
  ]);
}
const short = msWave();
const exact600 = msWave({ blocks: 9600 });
const long = msWave({ blocks: 9617 });

it("reconstructs all three independently decoded standard MS-ADPCM files", () => {
  for (const [bytes, sha] of [
    [short, "7e97f7d21dd8b571e9df726b6877d8d24e1aa5088d70bb5ee99e8e37a3072471"],
    [
      exact600,
      "82e4dac4b0fe92fe55509fa6b588a5239ef4094fb526dca30e52febd8f9dcc7f",
    ],
    [long, "b206b538ae138cab6b0fed36ee090bbf34ae1e2b6406dad8b1e42585242e7233"],
  ] as const) {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  }
});

it.each([
  { label: "4-second short", bytes: short },
  { label: "genuine 600-second", bytes: exact600 },
])(
  "preserves $label bytes without exact-duration certification",
  ({ bytes }) => {
    const data = bytes.toString("base64");
    const uri = "fixture://owned/ms.wav";
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

it("recognizes the known over-budget complete prefix", () => {
  expect(messageAudioAdmission(long.toString("base64"), "audio/wav")).toBe(
    "audioTooLong",
  );
});

it("rejects the actual long file through the common production preview entry", () => {
  const data = long.toString("base64");
  const attachment = Object.freeze({
    name: "original.wav",
    mimeType: "audio/wav",
    data,
  });
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("audioTooLong");
  expect(attachment.data === data).toBe(true);
});

it("applies that same limit to an actual embedded-resource attachment", () => {
  const data = long.toString("base64");
  const uri = "fixture://owned/long-ms.wav";
  const attachment = Object.freeze(
    normalizeMessageAttachment({
      type: "resource",
      resource: { uri, mimeType: "audio/wav", blob: data },
    })!,
  );
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("audioTooLong");
  expect(attachment.data === data).toBe(true);
  expect(attachment.uri).toBe(uri);
});

it("cannot bypass the recognized WAVE prefix with another allowed audio MIME", () => {
  const result = attachmentMediaAdmission({
    name: "original.wav",
    mimeType: "audio/mpeg",
    data: long.toString("base64"),
  });
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("audioTooLong");
});

it("uses strict greater-than on the complete prefix and leaves a padded last block unclassified", () => {
  // The 9601-block fact600 file decoded as600.0625s in selected CoreAudio, not
  // as600s. Fact-clipping behavior of other decoders is not certified here.
  expect(
    messageAudioAdmission(
      msWave({ blocks: 9601, factFrames: 4800000 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("notCovered");
  expect(
    messageAudioAdmission(
      msWave({ blocks: 9602 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});

it("does not use fact or a byte-rate hint to shorten independent encoded work", () => {
  // CoreAudio really decoded the SHA-identified fact1 file to601.0625s. Other
  // fact/rate variants below are structural controls, not native evidence.
  const factOne = msWave({ blocks: 9617, factFrames: 1 });
  expect(createHash("sha256").update(factOne).digest("hex")).toBe(
    "da155662a82036b4b9a43f83b7e55fd4660e0161a4910fd742188ce538dd8ff1",
  );
  for (const value of [
    { factFrames: 1 },
    { factFrames: 0xffffffff },
    { byteRate: 0 },
    { byteRate: 0xffffffff },
  ]) {
    expect(
      messageAudioAdmission(
        msWave({ blocks: 9617, ...value }).toString("base64"),
        "audio/wav",
      ),
    ).toBe("audioTooLong");
  }
});

it("counts a per-channel stereo clock once and accepts odd-sized stereo packing geometry", () => {
  expect(
    messageAudioAdmission(
      msWave({ blocks: 9617, channels: 2 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
  expect(
    messageAudioAdmission(
      msWave({ channels: 2, align: 15, samplesPerBlock: 3 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("notCovered");
});

it("keeps partial-tail compatibility but not an independently excessive complete prefix", () => {
  expect(
    messageAudioAdmission(
      msWave({ partialBytes: 1 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("notCovered");
  expect(
    messageAudioAdmission(
      msWave({ blocks: 9617, partialBytes: 1 }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});

it("leaves unknown packing, coefficient and extension variants compatible", () => {
  for (const value of [
    { bits: 3 },
    { channels: 3 },
    { samplesPerBlock: 499 },
    { coefficients: [[255, 0], ...standardCoefficients.slice(1)] },
    { coefficients: [...standardCoefficients, [1, 1]] },
  ]) {
    const data = msWave({ blocks: 9617, ...value }).toString("base64");
    expect(messageAudioAdmission(data, "audio/wav")).toBe("notCovered");
    expect(
      attachmentMediaAdmission({
        name: "unknown.wav",
        mimeType: "audio/wav",
        data,
      }).status,
    ).toBe("available");
  }
});

it("rejects impossible selected standard block/time geometry", () => {
  for (const value of [{ sampleRate: 0 }, { align: 0 }, { align: 6 }]) {
    expect(
      messageAudioAdmission(msWave(value).toString("base64"), "audio/wav"),
    ).toBe("invalid");
  }
});

it("does not let a playlist hide the known direct stored-data prefix", () => {
  expect(
    messageAudioAdmission(
      msWave({
        blocks: 9617,
        after: [{ kind: "plst", data: Buffer.alloc(0) }],
      }).toString("base64"),
      "audio/wav",
    ),
  ).toBe("audioTooLong");
});
