import { expect, it, vi } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { MESSAGE_MPEG_AUDIO_TEST_DATA as F } from "./message_mpeg_audio_admission_fixtures.test-support";
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
  "refuses complete601-second MPEG audio under%s without altering source",
  (mimeType) => {
    const input = {
      name: "Original MPEG audio",
      uri: "file:///owned/long.mp3",
      mimeType,
      data: F.LONG_601,
    };
    const before = JSON.stringify(input);
    const result = attachmentMediaAdmission(input);
    // First compare status to keep the expected pre-hook red from dumping4MB.
    expect(result.status).toBe("rejected");
    expect(result).toEqual({ status: "rejected", reason: "audioTooLong" });
    expect(JSON.stringify(input)).toBe(before);
  },
);

it.each(mimes)(
  "retains the complete short MPEG audio and original%s URI",
  (mimeType) => {
    expect(
      attachmentMediaAdmission({
        name: "Original short",
        mimeType,
        data: F.TINY,
      }),
    ).toEqual({
      status: "available",
      media: { kind: "audio", src: `data:${mimeType};base64,${F.TINY}` },
    });
  },
);

it("applies MPEG audio duration refusal to an official embedded resource blob", () => {
  const input = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/long.mp3",
      mimeType: "audio/mpeg",
      blob: F.LONG_601,
    },
  });
  expect(input).not.toBeNull();
  expect(attachmentMediaAdmission(input!).status).toBe("rejected");
  expect(attachmentMediaAdmission(input!)).toEqual({
    status: "rejected",
    reason: "audioTooLong",
  });
});

it("keeps byte admission before all MPEG header reads", () => {
  const read = vi.spyOn(MessageRasterReader.prototype, "u8");
  try {
    expect(
      attachmentMediaAdmission({
        name: "Large",
        mimeType: "audio/mpeg",
        data: "/wAA" + "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3)),
      }),
    ).toEqual({ status: "rejected", reason: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it("does not add MIME support or retrieve remote MPEG audio", () => {
  expect(
    attachmentMediaAdmission({
      name: "Not added",
      mimeType: "audio/x-mpeg",
      data: F.TINY,
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    attachmentMediaAdmission({
      name: "Remote",
      mimeType: "audio/mpeg",
      uri: "https://example.invalid/sample.mp3",
    }),
  ).toEqual({ status: "unavailable" });
});
