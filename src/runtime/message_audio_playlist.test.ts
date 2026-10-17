import { expect, it } from "vitest";
import { messageAudioAdmission } from "./message_audio_admission";
import {
  wavTestFile,
  waveTestRiff,
  type WaveTestChunk,
} from "./message_audio_fixtures.test-support";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";

// Declaration-only variants. Complete independently decoded PCM controls and
// the original failing gate are in the owned P13 investigation output. These
// fixtures are not codec, playlist playback or decoder-memory evidence.
function playlist(length: number): readonly WaveTestChunk[] {
  const cue = Buffer.alloc(28);
  cue.writeUInt32LE(1, 0);
  cue.writeUInt32LE(1, 4);
  cue.write("data", 12, 4, "ascii");
  const plst = Buffer.alloc(16);
  plst.writeUInt32LE(1, 0);
  plst.writeUInt32LE(1, 4);
  plst.writeUInt32LE(length, 8);
  plst.writeUInt32LE(1, 12);
  return [
    { kind: "cue ", data: cue },
    { kind: "plst", data: plst },
  ];
}

function dataFile(
  frames: number,
  position: "before" | "after" = "before",
  length = frames,
  format = 1,
): string {
  return wavTestFile({
    sampleRate: 1,
    frames,
    format,
    [position]: playlist(length),
  }).toString("base64");
}

it.each(["before", "after"] as const)(
  "retains the exact stored-frame boundary with a playlist %s data",
  (position) => {
    expect(messageAudioAdmission(dataFile(600, position), "audio/wav")).toBe(
      "notCovered",
    );
    expect(messageAudioAdmission(dataFile(601, position), "audio/wav")).toBe(
      "audioTooLong",
    );
  },
);

it("preserves the one-frame boundary at an ordinary PCM sample rate", () => {
  for (const [frames, expected] of [
    [4_800_000, "notCovered"],
    [4_800_001, "audioTooLong"],
  ] as const) {
    const data = wavTestFile({
      sampleRate: 8000,
      frames,
      before: playlist(frames),
    }).toString("base64");
    expect(messageAudioAdmission(data, "audio/wav")).toBe(expected);
  }
});

it.each([
  { format: 1, bits: 24, extensible: true },
  { format: 3, bits: 32, extensible: false },
  { format: 3, bits: 64, extensible: true },
])("checks known linear format %# despite playlist presence", (format) => {
  const data = wavTestFile({
    ...format,
    sampleRate: 1,
    frames: 601,
    before: playlist(601),
  }).toString("base64");
  expect(messageAudioAdmission(data, "audio/wav")).toBe("audioTooLong");
});

it("does not substitute the selected playlist section for the stored-data policy", () => {
  // A one-second selection does not erase the 601 seconds of known stored PCM.
  // Actual trimmed/looped playback remains unknown; the policy is unchanged.
  expect(messageAudioAdmission(dataFile(601, "before", 1), "audio/wav")).toBe(
    "audioTooLong",
  );
});

it("does not infer long playback by expanding an uncovered short-data playlist", () => {
  const file = wavTestFile({
    sampleRate: 1,
    frames: 1,
    before: playlist(1).map((chunk) => {
      if (chunk.kind === "plst") chunk.data.writeUInt32LE(0xffff_ffff, 12);
      return chunk;
    }),
  }).toString("base64");
  expect(messageAudioAdmission(file, "audio/wav")).toBe("notCovered");
});

it("retains independently known frame-alignment failure despite a playlist", () => {
  const bytes = wavTestFile({
    bits: 16,
    frames: 80,
    after: playlist(80),
  });
  const chunks: WaveTestChunk[] = [];
  for (let at = 12; at < bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    const kind = bytes.toString("ascii", at, at + 4);
    chunks.push({
      kind,
      data:
        kind === "data"
          ? Buffer.alloc(1)
          : Buffer.from(bytes.subarray(at + 8, at + 8 + size)),
    });
    at += 8 + size + (size % 2);
  }
  expect(
    messageAudioAdmission(waveTestRiff(chunks).toString("base64"), "audio/wav"),
  ).toBe("invalid");
});

it("does not apply PCM math to an unknown compression format", () => {
  expect(
    messageAudioAdmission(dataFile(601, "before", 601, 2), "audio/wav"),
  ).toBe("notCovered");
});

it("keeps genuine wavl data/silence layout outside the direct-data formula", () => {
  const plain = wavTestFile();
  const format = { kind: "fmt ", data: Buffer.from(plain.subarray(20, 36)) };
  const silence = Buffer.alloc(12);
  silence.write("slnt", 0, 4, "ascii");
  silence.writeUInt32LE(4, 4);
  silence.writeUInt32LE(0xffff_ffff, 8);
  const data = Buffer.concat([Buffer.from("wavl"), silence]);
  const file = waveTestRiff([format, ...playlist(1), { kind: "LIST", data }]);
  expect(messageAudioAdmission(file.toString("base64"), "audio/wav")).toBe(
    "notCovered",
  );
});

const long = dataFile(601);
const short = dataFile(600);
const audioMimes = [
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
];
it.each(audioMimes)(
  "keeps the selected signature budget under existing %s without changing data",
  (mimeType) => {
    const attachment = normalizeMessageAttachment({
      type: "audio",
      mimeType,
      data: long,
      uri: "fixture://owned/original-playlist.wav",
    })!;
    const original = JSON.stringify(attachment);
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toBe("audioTooLong");
    expect(JSON.stringify(attachment)).toBe(original);
  },
);

it("keeps the original short playlist bytes and source through resource admission", () => {
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "fixture://owned/original-short-playlist.wav",
      mimeType: "audio/wav",
      blob: short,
    },
  })!;
  const original = JSON.stringify(attachment);
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("available");
  if (result.status === "available")
    expect(result.media.src === `data:audio/wav;base64,${short}`).toBe(true);
  expect(JSON.stringify(attachment)).toBe(original);
});

it("rejects the same known long stored extent in a resource blob", () => {
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "fixture://owned/original-long-playlist.wav",
      mimeType: "audio/wav",
      blob: long,
    },
  })!;
  const original = JSON.stringify(attachment);
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toBe("audioTooLong");
  expect(JSON.stringify(attachment)).toBe(original);
});
