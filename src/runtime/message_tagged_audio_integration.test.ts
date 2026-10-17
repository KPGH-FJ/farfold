import { expect, it, vi } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import {
  MESSAGE_AUDIO_PREFIX_TEST_DATA as F,
  id3PrefixTestFile,
} from "./message_audio_prefix_fixtures.test-support";
import { MESSAGE_MPEG_AUDIO_TEST_DATA as MPEG } from "./message_mpeg_audio_admission_fixtures.test-support";
import { MessageRasterReader } from "./message_raster_reader";

const mimes = [
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

it.each(mimes)(
  "keeps the known tagged MPEG and ADTS time limits under %s",
  (mimeType) => {
    for (const data of [F.MPEG_LONG_601, F.ADTS_LONG_601]) {
      const input = {
        kind: "audio" as const,
        name: "Original tagged audio",
        uri: "file:///controlled/original",
        mimeType,
        data,
      };
      const before = JSON.stringify(input);
      const admission = attachmentMediaAdmission(input);
      expect(admission.status).toBe("rejected");
      expect(admission).toEqual({ status: "rejected", reason: "audioTooLong" });
      expect(JSON.stringify(input)).toBe(before);
    }
  },
);

it.each([
  F.MPEG_SHORT_3,
  F.MPEG_V22_SHORT_3,
  F.MPEG_V24_FOOTER_SHORT_3,
  F.ADTS_TINY,
])(
  "retains the exact original tagged bytes when admitting a known short stream",
  (data) => {
    expect(
      attachmentMediaAdmission({
        name: "Tagged",
        mimeType: "audio/mpeg",
        data,
      }),
    ).toEqual({
      status: "available",
      media: { kind: "audio", src: `data:audio/mpeg;base64,${data}` },
    });
  },
);

it.each([F.MPEG_LONG_601, F.ADTS_LONG_601])(
  "applies the same tagged time gate to an official resource blob",
  (blob) => {
    const input = normalizeMessageAttachment({
      type: "resource",
      resource: {
        uri: "file:///controlled/tagged",
        mimeType: "audio/mpeg",
        blob,
      },
    });
    expect(input?.data).toBe(blob);
    expect(attachmentMediaAdmission(input!).status).toBe("rejected");
  },
);

it("keeps unrecognized tag versions uncovered without stripping or reinterpreting their bytes", () => {
  const data = id3PrefixTestFile(MPEG.TINY, { version: 5 });
  const input = { name: "Unknown metadata", mimeType: "audio/mpeg", data };
  const result = attachmentMediaAdmission(input);
  expect(result).toEqual({
    status: "available",
    media: { kind: "audio", src: `data:audio/mpeg;base64,${data}` },
  });
});

it("runs the constant-time byte gate before tag or audio header readers", () => {
  const read = vi.spyOn(MessageRasterReader.prototype, "u8");
  try {
    expect(
      attachmentMediaAdmission({
        name: "Too large",
        mimeType: "audio/aac",
        data: "SUQz" + "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3)),
      }),
    ).toEqual({ status: "rejected", reason: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it("does not add MIME types or fetch remote tagged audio", () => {
  expect(
    attachmentMediaAdmission({
      name: "Other type",
      mimeType: "audio/x-mpeg",
      data: F.MPEG_SHORT_3,
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    attachmentMediaAdmission({
      name: "Remote",
      mimeType: "audio/mpeg",
      uri: "https://example.invalid/tagged.mp3",
    }),
  ).toEqual({ status: "unavailable" });
});
