import { expect, it } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import {
  MESSAGE_MP4_AUDIO_TEST_DATA as F,
  mp4AudioTestFile,
  mp4TestTrack,
} from "./message_mp4_audio_fixtures.test-support";

const audioMimes = [
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/aac",
];

it.each(audioMimes)(
  "checks the complete MP4 signature under already-allowed %s",
  (mimeType) => {
    const content = {
      type: "audio",
      mimeType,
      data: F.LONG_601,
      uri: "fixture://owned/original-long.m4a",
    };
    const attachment = normalizeMessageAttachment(content)!;
    const before = JSON.stringify(attachment);
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toBe("audioTooLong");
    expect(JSON.stringify(attachment)).toBe(before);
  },
);
it.each(audioMimes)(
  "applies the same complete-file bound to a %s resource blob",
  (mimeType) => {
    const attachment = normalizeMessageAttachment({
      type: "resource",
      resource: {
        uri: "fixture://owned/original-long.m4a",
        mimeType,
        blob: F.LONG_601,
      },
    })!;
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toBe("audioTooLong");
  },
);
it("retains the exact original short complete MP4 data URL", () => {
  const attachment = normalizeMessageAttachment({
    type: "audio",
    mimeType: "audio/mp4",
    data: F.SHORT_3,
  })!;
  const result = attachmentMediaAdmission(attachment);
  expect(result.status).toBe("available");
  if (result.status === "available") {
    expect(result.media.kind).toBe("audio");
    expect(result.media.src).toBe(`data:audio/mp4;base64,${F.SHORT_3}`);
  }
});
it("does not promote an unknown timing layout to a new unsupported format", () => {
  const data = mp4AudioTestFile({ tracks: [mp4TestTrack({ mdhdVersion: 2 })] });
  expect(
    attachmentMediaAdmission({
      name: "Unknown timing",
      mimeType: "audio/mp4",
      data,
    }).status,
  ).toBe("available");
});
it("does not expand the existing MIME list to video or audio/x-m4a", () => {
  for (const mimeType of ["video/mp4", "audio/x-m4a"])
    expect(
      attachmentMediaAdmission({
        name: "Unknown MIME",
        mimeType,
        data: F.SHORT_3,
      }).status,
    ).toBe("unavailable");
});
