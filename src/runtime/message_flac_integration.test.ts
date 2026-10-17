import { expect, it, vi } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { MESSAGE_FLAC_TEST_DATA } from "./message_flac_fixtures.test-support";
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
  "refuses the independently decoded 601-second FLAC under %s",
  (mimeType) => {
    const input = {
      kind: "audio" as const,
      name: "Original FLAC",
      uri: "file:///owned/original.flac",
      mimeType,
      data: MESSAGE_FLAC_TEST_DATA.LONG_601,
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
  "preserves a short complete FLAC and its declared %s source",
  (mimeType) => {
    const result = attachmentMediaAdmission({
      name: "Short FLAC",
      mimeType,
      data: MESSAGE_FLAC_TEST_DATA.TINY,
    });
    // Admission under a different MIME is not proof that its codec will play it.
    expect(result).toEqual({
      status: "available",
      media: {
        kind: "audio",
        src: `data:${mimeType};base64,${MESSAGE_FLAC_TEST_DATA.TINY}`,
      },
    });
  },
);

it("applies the same refusal to an official embedded resource blob", () => {
  const attachment = normalizeMessageAttachment({
    type: "resource",
    resource: {
      uri: "file:///owned/original.flac",
      mimeType: "audio/flac",
      blob: MESSAGE_FLAC_TEST_DATA.LONG_601,
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

it("keeps the byte gate ahead of all FLAC declaration reads", () => {
  const read = vi.spyOn(MessageRasterReader.prototype, "u8");
  try {
    const data = "ZkxhQwAA" + "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3));
    expect(
      attachmentMediaAdmission({
        name: "Too large",
        mimeType: "audio/flac",
        data,
      }),
    ).toEqual({ status: "rejected", reason: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it("does not add new MIME support or fetch a FLAC link without embedded data", () => {
  expect(
    attachmentMediaAdmission({
      name: "Unsupported declaration",
      mimeType: "audio/x-flac",
      data: MESSAGE_FLAC_TEST_DATA.TINY,
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    attachmentMediaAdmission({
      name: "Remote FLAC",
      mimeType: "audio/flac",
      uri: "https://example.invalid/original.flac",
    }),
  ).toEqual({ status: "unavailable" });
});
