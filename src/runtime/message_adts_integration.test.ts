import { expect, it, vi } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { MESSAGE_ADTS_TEST_DATA } from "./message_adts_fixtures.test-support";
import { MessageRasterReader } from "./message_raster_reader";

const audioMimes = [
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
];

it.each(audioMimes)(
  "refuses the independently decoded 601-second ADTS AAC under %s",
  (mimeType) => {
    const input = {
      kind: "audio" as const,
      name: "Original ADTS AAC",
      uri: "file:///owned/original.aac",
      mimeType,
      data: MESSAGE_ADTS_TEST_DATA.LONG_601,
    };
    const before = JSON.stringify(input);
    expect(attachmentMediaAdmission(input)).toEqual({
      status: "rejected",
      reason: "audioTooLong",
    });
    expect(JSON.stringify(input)).toBe(before);
  },
);

it.each(audioMimes)(
  "preserves a short complete ADTS AAC and its declared %s source",
  (mimeType) => {
    const result = attachmentMediaAdmission({
      name: "Short ADTS AAC",
      mimeType,
      data: MESSAGE_ADTS_TEST_DATA.TINY,
    });
    // Admission under a different MIME is not proof that its codec will play it.
    expect(result).toEqual({
      status: "available",
      media: {
        kind: "audio",
        src: `data:${mimeType};base64,${MESSAGE_ADTS_TEST_DATA.TINY}`,
      },
    });
  },
);

it("applies the same refusal to an official embedded resource blob", () => {
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/original.aac",
      mimeType: "audio/aac",
      blob: MESSAGE_ADTS_TEST_DATA.LONG_601,
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

it("keeps the byte gate ahead of all ADTS AAC declaration reads", () => {
  const read = vi.spyOn(MessageRasterReader.prototype, "u8");
  try {
    const data = "ZkxhQwAA" + "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3));
    expect(
      attachmentMediaAdmission({
        name: "Too large",
        mimeType: "audio/aac",
        data,
      }),
    ).toEqual({ status: "rejected", reason: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it("does not add new MIME support or fetch a ADTS AAC link without embedded data", () => {
  expect(
    attachmentMediaAdmission({
      name: "Unsupported declaration",
      mimeType: "audio/x-aac",
      data: MESSAGE_ADTS_TEST_DATA.TINY,
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    attachmentMediaAdmission({
      name: "Remote ADTS AAC",
      mimeType: "audio/aac",
      uri: "https://example.invalid/original.aac",
    }),
  ).toEqual({ status: "unavailable" });
});
