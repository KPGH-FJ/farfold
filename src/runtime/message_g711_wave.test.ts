import { expect, it } from "vitest";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import { messageAudioAdmission } from "./message_audio_admission";
import {
  G711_WAVE_PROVENANCE,
  g711WaveBytes,
  g711WaveControl,
} from "./message_g711_wave_fixtures.test-support";

const controls = G711_WAVE_PROVENANCE.map(g711WaveControl);

it.each(controls.filter((control) => control.seconds <= 600))(
  "keeps complete $case original bytes and source available",
  ({ case: name, data }) => {
    const uri = `fixture://owned/${name}.wav`;
    const attachment = Object.freeze(
      normalizeMessageAttachment({
        type: "audio",
        mimeType: "audio/wav",
        data,
        uri,
      })!,
    );
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("available");
    if (result.status === "available")
      expect(result.media.src === `data:audio/wav;base64,${data}`).toBe(true);
    expect(attachment.data === data).toBe(true);
    expect(attachment.uri).toBe(uri);
  },
);

it.each(controls.filter((control) => control.seconds > 600))(
  "extends stored-frame budget to complete $case under audio/wav",
  ({ case: name, data }) => {
    const uri = `fixture://owned/${name}.wav`;
    const attachment = Object.freeze(
      normalizeMessageAttachment({
        type: "audio",
        mimeType: "audio/wav",
        data,
        uri,
      })!,
    );
    const result = attachmentMediaAdmission(attachment);
    // This is the proposed recognition extension. Old notCovered compatibility
    // is not a previously claimed complete-duration or memory guarantee.
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toBe("audioTooLong");
    expect(attachment.data === data).toBe(true);
    expect(attachment.uri).toBe(uri);
  },
);

it.each(controls.filter((control) => control.seconds > 600))(
  "uses the same complete $case signature under another already allowed MIME",
  ({ case: name, data }) => {
    const attachment = Object.freeze(
      normalizeMessageAttachment({
        type: "audio",
        mimeType: "audio/mpeg",
        data,
        uri: `fixture://owned/${name}.wav`,
      })!,
    );
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toBe("audioTooLong");
    expect(attachment.data === data).toBe(true);
  },
);

it.each(controls.filter((control) => control.seconds > 600))(
  "uses the same complete $case through official embedded resource content",
  ({ case: name, data }) => {
    const uri = `fixture://owned/${name}.wav`;
    const attachment = Object.freeze(
      normalizeMessageAttachment({
        type: "resource",
        resource: { mimeType: "audio/wav", blob: data, uri },
      })!,
    );
    const result = attachmentMediaAdmission(attachment);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(result.reason).toBe("audioTooLong");
    expect(attachment.data === data).toBe(true);
    expect(attachment.uri).toBe(uri);
  },
);

// The following boundary/metadata variants are proposed structural controls,
// not additional independently decoded native inputs.
it.each([6, 7] as const)(
  "keeps the exact one-stored-sample boundary for tag%i",
  (tag) => {
    expect(
      messageAudioAdmission(
        g711WaveBytes(tag, 4800001).toString("base64"),
        "audio/wav",
      ),
    ).toBe("audioTooLong");
  },
);
it.each([6, 7] as const)(
  "checks known tag%i fields without trusting fact to shorten stored data",
  (tag) => {
    const bytes = g711WaveBytes(tag, 4808000);
    bytes.writeUInt32LE(1, 46);
    expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
      "audioTooLong",
    );
  },
);
it.each([6, 7] as const)(
  "rejects inconsistent known tag%i sample metadata",
  (tag) => {
    for (const [at, value] of [
      [22, 0],
      [32, 2],
      [34, 16],
    ] as const) {
      const bytes = g711WaveBytes(tag, 80);
      bytes.writeUInt16LE(value, at);
      expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
        "invalid",
      );
    }
    for (const at of [24, 28]) {
      const bytes = g711WaveBytes(tag, 80);
      bytes.writeUInt32LE(at === 24 ? 0 : 1, at);
      expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
        "invalid",
      );
    }
  },
);
it.each([6, 7] as const)(
  "keeps unrecognized tag%i extension contents uncovered",
  (tag) => {
    const original = g711WaveBytes(tag, 80);
    const bytes = Buffer.concat([
      original.subarray(0, 38),
      Buffer.from([7, 0]),
      original.subarray(38),
    ]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(19, 16);
    bytes.writeUInt16LE(1, 36);
    expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
      "notCovered",
    );
  },
);
it("does not apply the new G711 sample relationship to another compressed codec", () => {
  const bytes = g711WaveBytes(6, 80);
  bytes.writeUInt16LE(2, 20);
  expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
    "notCovered",
  );
});

it.each([6, 7] as const)(
  "uses interleaved frames, not summed channels, for tag%i",
  (tag) => {
    expect(
      messageAudioAdmission(
        g711WaveBytes(tag, 4800000, 2).toString("base64"),
        "audio/wav",
      ),
    ).toBe("withinBudget");
    expect(
      messageAudioAdmission(
        g711WaveBytes(tag, 4800001, 2).toString("base64"),
        "audio/wav",
      ),
    ).toBe("audioTooLong");
  },
);
it.each([6, 7] as const)(
  "checks actual odd tag%i data padding without counting it as a sample",
  (tag) => {
    const bytes = g711WaveBytes(tag, 81);
    expect(messageAudioAdmission(bytes.toString("base64"), "audio/wav")).toBe(
      "withinBudget",
    );
    const missingPad = bytes.subarray(0, -1);
    missingPad.writeUInt32LE(missingPad.length - 8, 4);
    expect(
      messageAudioAdmission(missingPad.toString("base64"), "audio/wav"),
    ).toBe("invalid");
  },
);
