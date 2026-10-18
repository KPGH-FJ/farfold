import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";

// Complete, unmodified official-library encoder output for self-generated PCM.
// Both controls were fully consumed through libvorbisfile. These are selected
// same-vendor roundtrips, not all-codec or browser playback evidence.
function control(name: string, pin: string) {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== pin)
    throw new Error("Complete Vorbis control bytes changed");
  return bytes.toString("base64");
}
const short = control(
  "message-vorbis-short-2.ogg",
  "985e6608b694a89391f55a0b85766f114488354c5fd2317b42197ba00a94a53e",
);
const long = control(
  "message-vorbis-long-610.ogg",
  "0ab5c53906da7a9e80f07407fbb99030026409e5a2553330bbba8799d6392eb9",
);
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
  "refuses the complete long Vorbis under %s without changing the attachment",
  (mimeType) => {
    const input = {
      kind: "audio" as const,
      name: "Long Vorbis",
      mimeType,
      data: long,
    };
    const original = JSON.stringify(input);
    expect(attachmentMediaAdmission(input)).toEqual({
      status: "rejected",
      reason: "audioTooLong",
    });
    expect(JSON.stringify(input)).toBe(original);
  },
);

it.each(audioMimes)(
  "preserves short Vorbis bytes and the declared %s source",
  (mimeType) => {
    expect(
      attachmentMediaAdmission({ name: "Short Vorbis", mimeType, data: short }),
    ).toEqual({
      status: "available",
      media: { kind: "audio", src: `data:${mimeType};base64,${short}` },
    });
    // Cross-label admission does not certify the browser codec for that label.
  },
);

it("retains embedded resource content while applying the same preview limit", () => {
  const content = {
    type: "resource",
    resource: {
      uri: "file:///farfold-controlled/long.ogg",
      mimeType: "audio/ogg",
      blob: long,
    },
  };
  const original = JSON.stringify(content);
  const attachment = normalizeMessageAttachment(content);
  expect(attachment?.data).toBe(long);
  expect(attachmentMediaAdmission(attachment!)).toEqual({
    status: "rejected",
    reason: "audioTooLong",
  });
  expect(JSON.stringify(content)).toBe(original);
});

it("does not add MIME support or read a resource link to obtain missing bytes", () => {
  expect(
    attachmentMediaAdmission({
      name: "Unknown label",
      mimeType: "audio/x-ogg",
      data: short,
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    attachmentMediaAdmission({
      name: "Link only",
      mimeType: "audio/ogg",
      uri: "https://example.invalid/never-read.ogg",
    }),
  ).toEqual({ status: "unavailable" });
});
