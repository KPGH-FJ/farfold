import { expect, it, vi } from "vitest";
import {
  MAX_MESSAGE_AUDIO_RECORDS,
  messageAudioAdmission,
} from "./message_audio_admission";
import {
  MESSAGE_AUDIO_WAV_TEST_DATA,
  wavTestFile,
  waveTestRiff,
} from "./message_audio_fixtures.test-support";
import {
  AUDIO_FIXTURE_DATA,
  largeAudioCapture,
} from "./audio_input.test-support";

const admit = (bytes: Buffer, mime = "audio/wav") =>
  messageAudioAdmission(bytes.toString("base64"), mime);
function chunks(file = wavTestFile()) {
  const result: { kind: string; data: Buffer }[] = [];
  for (let at = 12; at < file.length;) {
    const length = file.readUInt32LE(at + 4);
    result.push({
      kind: file.toString("ascii", at, at + 4),
      data: Buffer.from(file.subarray(at + 8, at + 8 + length)),
    });
    at += 8 + length + (length % 2);
  }
  return result;
}

it.each([MESSAGE_AUDIO_WAV_TEST_DATA, AUDIO_FIXTURE_DATA])(
  "admits independently CPython-generated real WAV control %#",
  (data) =>
    expect(messageAudioAdmission(data, "audio/wav")).toBe("withinBudget"),
);
it("keeps the independent exact 16MiB PCM8 stereo/96kHz control", () => {
  expect(messageAudioAdmission(largeAudioCapture().data, "audio/wav")).toBe(
    "withinBudget",
  );
});
it.each([1, 2, 3, 4, 6, 8])(
  "handles %i linear channels without copying PCM restrictions from input",
  (channels) => {
    expect(admit(wavTestFile({ channels, bits: 24 }))).toBe("withinBudget");
  },
);
it.each([8, 16, 20, 24, 32])("retains classic PCM precision %i", (bits) => {
  expect(admit(wavTestFile({ bits }))).toBe("withinBudget");
});
it.each([32, 64])(
  "handles IEEE float %i and its standard extensible form",
  (bits) => {
    for (const extensible of [false, true])
      expect(admit(wavTestFile({ format: 3, bits, extensible }))).toBe(
        "withinBudget",
      );
  },
);
it("retains extensible 20-bit precision in a 24-bit container", () => {
  expect(
    admit(wavTestFile({ bits: 24, validBits: 20, extensible: true })),
  ).toBe("withinBudget");
});
it.each([
  "mpeg",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "wave",
  "x-wav",
  "webm",
  "flac",
  "aac",
])("checks WAVE signatures under audio/%s", (mime) => {
  expect(
    admit(wavTestFile({ sampleRate: 1, frames: 601 }), `audio/${mime}`),
  ).toBe("audioTooLong");
});
it.each([1, 8000, 16000])(
  "uses actual PCM frame count at sample rate %i, not byte-rate alone",
  (sampleRate) => {
    expect(admit(wavTestFile({ sampleRate, frames: sampleRate * 600 }))).toBe(
      "withinBudget",
    );
    expect(
      admit(wavTestFile({ sampleRate, frames: sampleRate * 600 + 1 })),
    ).toBe("audioTooLong");
  },
);
it("uses frames for float/extensible and ignores a bogus fact sample count", () => {
  for (const extensible of [false, true]) {
    const file = chunks(
      wavTestFile({
        format: 3,
        bits: 32,
        sampleRate: 1,
        frames: 601,
        extensible,
      }),
    );
    file.find((chunk) => chunk.kind === "fact")!.data.writeUInt32LE(1);
    expect(admit(waveTestRiff(file))).toBe("audioTooLong");
  }
});
it("counts interleaved multichannel frames without dividing duration by channels twice", () => {
  for (const extensible of [false, true])
    expect(
      admit(
        wavTestFile({
          format: 3,
          bits: 32,
          channels: 6,
          sampleRate: 1,
          frames: 601,
          extensible,
        }),
      ),
    ).toBe("audioTooLong");
});
it.each([
  "align",
  "rate",
  "channels",
  "sample rate",
  "partial frame",
  "extensible precision",
  "extensible size",
])("rejects inconsistent linear declaration: %s", (kind) => {
  const file = chunks(
    wavTestFile({ bits: 16, extensible: kind.startsWith("extensible") }),
  );
  const fmt = file[0].data;
  if (kind === "align") fmt.writeUInt16LE(1, 12);
  if (kind === "rate") fmt.writeUInt32LE(1, 8);
  if (kind === "channels") fmt.writeUInt16LE(0, 2);
  if (kind === "sample rate") fmt.writeUInt32LE(0, 4);
  if (kind === "partial frame") file.at(-1)!.data = Buffer.alloc(1);
  if (kind === "extensible precision") fmt.writeUInt16LE(17, 18);
  if (kind === "extensible size") fmt.writeUInt16LE(23, 16);
  expect(admit(waveTestRiff(file))).toBe("invalid");
});
it("does not impose PCM assumptions or use fact duration for unknown compression", () => {
  const file = chunks(wavTestFile({ format: 2 }));
  file[0].data.writeUInt16LE(0, 14);
  file[0].data.writeUInt16LE(123, 12);
  file[0].data.writeUInt32LE(1, 8);
  file.find((chunk) => chunk.kind === "fact")!.data.writeUInt32LE(0xffffffff);
  expect(admit(waveTestRiff(file))).toBe("notCovered");
  file[0].data = file[0].data.subarray(0, 14);
  expect(admit(waveTestRiff(file))).toBe("notCovered");
});
it("does not mistake a proprietary extensible GUID or uncommon float layout for PCM", () => {
  const file = chunks(wavTestFile({ extensible: true }));
  file[0].data[39] ^= 1;
  expect(admit(waveTestRiff(file))).toBe("notCovered");
  expect(admit(wavTestFile({ format: 3, bits: 16 }))).toBe("notCovered");
});
it("preserves opaque chunks and odd fmt/data padding", () => {
  const file = chunks(
    wavTestFile({
      frames: 81,
      before: [{ kind: "JUNK", data: Buffer.from([1]) }],
    }),
  );
  file[0].data = Buffer.concat([file[0].data, Buffer.from([7])]);
  expect(admit(waveTestRiff(file))).toBe("withinBudget");
});
it.each([
  "duplicate fmt",
  "duplicate data",
  "data before fmt",
  "missing fmt",
  "missing data",
  "short fmt",
])("rejects malformed simple WAVE layout: %s", (kind) => {
  const file = chunks();
  if (kind === "duplicate fmt") file.unshift(file[0]);
  if (kind === "duplicate data") file.push(file[1]);
  if (kind === "data before fmt") file.reverse();
  if (kind === "missing fmt") file.shift();
  if (kind === "missing data") file.pop();
  if (kind === "short fmt") file[0].data = Buffer.alloc(13);
  expect(admit(waveTestRiff(file))).toBe("invalid");
});
it("retains wavl with repeated data/silence as a distinct ungoverned layout", () => {
  const file = chunks();
  file[1] = { kind: "LIST", data: Buffer.from("wavl") };
  expect(admit(waveTestRiff(file))).toBe("notCovered");
  const plain = chunks();
  plain.push({ kind: "plst", data: Buffer.alloc(0) });
  expect(admit(waveTestRiff(plain))).toBe("notCovered");
});
it("checks RIFF size, complete chunk header/payload and required odd padding", () => {
  const valid = wavTestFile();
  const badSize = Buffer.from(valid);
  badSize.writeUInt32LE(1, 4);
  const badChunk = Buffer.from(valid);
  badChunk.writeUInt32LE(0xffffffff, 40);
  const tail = Buffer.concat([valid, Buffer.from([1])]);
  tail.writeUInt32LE(tail.length - 8, 4);
  const odd = wavTestFile({ frames: 81 }).subarray(0, -1);
  odd.writeUInt32LE(odd.length - 8, 4);
  for (const file of [badSize, badChunk, tail, odd])
    expect(admit(file)).toBe("invalid");
});
it("bounds visited top-level chunk records, including ignored chunks", () => {
  const before = Array.from({ length: MAX_MESSAGE_AUDIO_RECORDS - 2 }, () => ({
    kind: "JUNK",
    data: Buffer.alloc(0),
  }));
  expect(admit(wavTestFile({ before }))).toBe("withinBudget");
  before.push({ kind: "JUNK", data: Buffer.alloc(0) });
  expect(admit(wavTestFile({ before }))).toBe("audioTooComplex");
});
it.each(["RIFX", "RF64", "riff", "OggS", "fLaC", "ID3", "not WAVE"])(
  "leaves other audio containers %s outside this slice",
  (signature) => {
    expect(admit(Buffer.from(signature))).toBe("notCovered");
  },
);
it("does not allocate full binary/URL/decoder or mutate the source", () => {
  const atob = vi.spyOn(globalThis, "atob");
  try {
    const original = MESSAGE_AUDIO_WAV_TEST_DATA;
    expect(messageAudioAdmission(original, "audio/WAV")).toBe("withinBudget");
    expect(atob).not.toHaveBeenCalled();
    expect(MESSAGE_AUDIO_WAV_TEST_DATA).toBe(original);
    expect(messageAudioAdmission(original, "image/png")).toBe("notCovered");
  } finally {
    atob.mockRestore();
  }
});
