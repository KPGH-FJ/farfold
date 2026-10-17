import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { messageMpegAudioAdmission as admit } from "./message_mpeg_audio_admission";
import { MessageRasterReader } from "./message_raster_reader";
import {
  MESSAGE_MPEG_AUDIO_TEST_DATA as F,
  MESSAGE_MPEG_AUDIO_TEST_PROVENANCE as P,
  mpegAudioTestFile as file,
  mpegAudioTestFrame as frame,
} from "./message_mpeg_audio_admission_fixtures.test-support";

const repeat = (part: Buffer, count: number) =>
  file(Buffer.concat(Array(count).fill(part)));

it.each(["TINY", "SHORT_3", "LONG_601"] as const)(
  "reconstructs complete real%s frame segments exactly",
  (key) => {
    const raw = Buffer.from(F[key], "base64");
    expect(raw.length).toBe(P[key].bytes);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(P[key].sha256);
  },
);
it("admits the complete independently decoded short control", () => {
  expect(admit(F.TINY)).toBe("withinBudget");
  expect(admit(F.SHORT_3)).toBe("withinBudget");
});
it("refuses the complete independently decoded601-second control", () => {
  expect(admit(F.LONG_601)).toBe("audioTooLong");
});

it.each([0, 2, 3] as const)(
  "walks every indexed bitrate and rate of version%s",
  (version) => {
    for (let rateIndex = 0; rateIndex < 3; rateIndex++)
      for (let bitrateIndex = 1; bitrateIndex < 15; bitrateIndex++)
        for (const padding of [0, 1])
          expect(
            admit(file(frame({ version, rateIndex, bitrateIndex, padding }))),
          ).toBe("withinBudget");
  },
);
it.each([
  [3, 25000],
  [2, 25000],
  [0, 12500],
] as const)(
  "applies exact600-second boundary for version%s",
  (version, count) => {
    const f = frame({ version, rateIndex: 1 });
    expect(admit(repeat(f, count))).toBe("withinBudget");
    expect(admit(repeat(f, count + 1))).toBe("audioTooLong");
  },
);
it("does not accumulate floating error over mixed-rate frame declarations", () => {
  const high = frame({ version: 3, rateIndex: 1 });
  const low = frame({ version: 2, rateIndex: 1 });
  const frames = Buffer.concat([
    ...Array(12500).fill(high),
    ...Array(12500).fill(low),
  ]);
  expect(admit(file(frames))).toBe("withinBudget");
  expect(admit(file(frames, high))).toBe("audioTooLong");
});
it.each([0, 1, 2, 3])("never multiplies duration by channel mode%s", (mode) => {
  const f = frame({ rateIndex: 1, mode });
  expect(admit(repeat(f, 25000))).toBe("withinBudget");
});
it.each([0, 2, 3] as const)(
  "keeps CRC version%s partial while applying known time",
  (version) => {
    const f = frame({ version, rateIndex: 1, crc: true });
    expect(admit(file(f))).toBe("notCovered");
    expect(admit(repeat(f, version === 0 ? 12501 : 25001))).toBe(
      "audioTooLong",
    );
  },
);
it("allows variable bitrate/padding/channel headers without inventing payload consistency", () => {
  expect(
    admit(
      file(
        frame(),
        frame({ bitrateIndex: 14, padding: 1, mode: 0 }),
        frame({ bitrateIndex: 7 }),
      ),
    ),
  ).toBe("withinBudget");
});
it("does not trust Xing duration to replace the actual complete frame walk", () => {
  const first = frame();
  first.write("Xing", 21);
  first.writeUInt32BE(1, 25);
  first.writeUInt32BE(1, 29);
  expect(admit(file(first, Buffer.from(F.LONG_601, "base64")))).toBe(
    "audioTooLong",
  );
});
it.each([
  "ID3",
  "RIFF",
  "fLaC",
  "OggS",
  "ADIF",
  "\xff\xf9",
  "\xff\xfd",
  "\xff\xff",
])("does not search past non-LayerIII prefix%j", (prefix) => {
  expect(admit(file(Buffer.from(prefix, "binary"), frame()))).toBe(
    "notMpegAudio",
  );
});
it("leaves free bitrate extent unknown without scanning later payload for sync", () => {
  const free = frame();
  free[2] &= 15;
  expect(admit(file(free, Buffer.from(F.LONG_601, "base64")))).toBe(
    "notCovered",
  );
  expect(admit(file(Buffer.from(F.LONG_601, "base64"), free))).toBe(
    "audioTooLong",
  );
});
it.each(["TAG", "ID3", "APETAGEX", "opaque"])(
  "keeps unframed%s tail partial without hiding known excess",
  (tag) => {
    expect(admit(file(frame(), Buffer.from(tag)))).toBe("notCovered");
    expect(
      admit(file(Buffer.from(F.LONG_601, "base64"), Buffer.from(tag))),
    ).toBe("audioTooLong");
  },
);
it.each(["version", "rate", "bitrate"])(
  "rejects the explicitly reserved%s header value",
  (key) => {
    const f = frame();
    if (key === "version") f[1] = (f[1] & ~24) | 8;
    if (key === "rate") f[2] |= 12;
    if (key === "bitrate") f[2] |= 240;
    expect(admit(file(f))).toBe("invalid");
  },
);
it.each([2, 3])(
  "rejects identified LayerIII truncated to%s header bytes",
  (length) => {
    expect(admit(file(frame().subarray(0, length)))).toBe("invalid");
  },
);
it("requires every known frame extent to fit the admitted bytes", () => {
  expect(admit(file(frame().subarray(0, -1)))).toBe("invalid");
  expect(admit(file(frame(), frame().subarray(0, -1)))).toBe("invalid");
});
it("reads only bounded headers without a full decoded allocation", () => {
  //11000*1440B is below16MiB; known declaration duration is396seconds.
  const data = repeat(
    frame({ version: 3, rateIndex: 2, bitrateIndex: 14 }),
    11000,
  );
  let reads = 0;
  const original = MessageRasterReader.prototype.u8;
  const spy = vi
    .spyOn(MessageRasterReader.prototype, "u8")
    .mockImplementation(function (this: MessageRasterReader, at) {
      reads++;
      return original.call(this, at);
    });
  const decoder = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw Error("Full binary allocation forbidden");
  });
  try {
    expect(admit(data)).toBe("withinBudget");
    expect(reads).toBeLessThan(11000 * 10);
    expect(decoder).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    decoder.mockRestore();
  }
});
