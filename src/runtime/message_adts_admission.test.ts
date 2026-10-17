import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { messageAdtsAdmission as admit } from "./message_adts_admission";
import { MessageRasterReader } from "./message_raster_reader";
import {
  MESSAGE_ADTS_TEST_DATA as F,
  MESSAGE_ADTS_TEST_PROVENANCE as P,
  adtsTestFile as file,
  adtsTestFrame as frame,
} from "./message_adts_fixtures.test-support";

const repeat = (f: Buffer, count: number) =>
  file(Buffer.concat(Array(count).fill(f)));

it.each(["TINY", "LONG_601"] as const)(
  "rebuilds the complete real%s encoder output with its original file hash",
  (key) => {
    const bytes = Buffer.from(F[key], "base64");
    expect(bytes.length).toBe(P[key].bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      P[key].sha256,
    );
  },
);

it("admits the complete independently decoded short AAC control", () => {
  expect(admit(F.TINY)).toBe("withinBudget");
});

it("refuses the complete independently decoded601-second AAC before URL creation", () => {
  expect(admit(F.LONG_601)).toBe("audioTooLong");
});

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
  "admits the known standard sample-rate index%s declaration",
  (rateIndex) => {
    expect(admit(file(frame({ rateIndex })))).toBe("withinBudget");
  },
);

it.each([1, 2, 3, 4])("counts%s raw blocks per frame", (blocks) => {
  const count = Math.floor((600 * 8000) / (1024 * blocks));
  expect(admit(repeat(frame({ blocks }), count))).toBe("withinBudget");
  expect(admit(repeat(frame({ blocks }), count + 1))).toBe("audioTooLong");
});

it("admits exactly600 seconds and refuses one more declared frame", () => {
  const f = frame({ rateIndex: 0 });
  expect(admit(repeat(f, 56_250))).toBe("withinBudget");
  expect(admit(repeat(f, 56_251))).toBe("audioTooLong");
});

it.each([false, true])(
  "sums mixed standard rates exactly in either order%s",
  (reverse) => {
    const high = Buffer.concat(Array(56_248).fill(frame({ rateIndex: 0 })));
    const low = frame({ rateIndex: 3 });
    const frames = reverse ? [low, high] : [high, low];
    expect(admit(file(...frames))).toBe("withinBudget");
    expect(admit(file(...frames, frame({ rateIndex: 0 })))).toBe(
      "audioTooLong",
    );
  },
);

it.each([0, 1, 2, 7])(
  "does not multiply time by channel configuration%s",
  (channelConfig) => {
    expect(admit(file(frame({ channelConfig })))).toBe("withinBudget");
  },
);

it.each([false, true])(
  "supports either MPEG ID bit%s without mistaking layer bits",
  (mpeg2) => {
    expect(admit(file(frame({ mpeg2 })))).toBe("withinBudget");
  },
);

it.each([0, 2, 3])(
  "preserves unknown profile%s without hiding later known time",
  (profile) => {
    const unknown = frame({ profile });
    expect(admit(file(unknown))).toBe("notCovered");
    expect(admit(file(unknown, Buffer.from(F.LONG_601, "base64")))).toBe(
      "audioTooLong",
    );
  },
);

it.each([13, 14, 15])(
  "preserves unknown rate%s without hiding later known time",
  (rateIndex) => {
    const unknown = frame({ rateIndex });
    expect(admit(file(unknown))).toBe("notCovered");
    expect(admit(file(unknown, Buffer.from(F.LONG_601, "base64")))).toBe(
      "audioTooLong",
    );
  },
);

it.each([1, 2, 4])(
  "leaves CRC layout%s uncovered while applying known duration",
  (blocks) => {
    expect(admit(file(frame({ crc: true, blocks })))).toBe("notCovered");
    const count = Math.floor((600 * 8000) / (1024 * blocks)) + 1;
    expect(admit(repeat(frame({ crc: true, blocks }), count))).toBe(
      "audioTooLong",
    );
  },
);

it.each(["ID3", "ADIF", "OggS", "fLaC", "RIFF", "\xff\xfb", "\x56\xe0"])(
  "does not search past other transport/prefix%j for sync",
  (prefix) => {
    expect(admit(file(Buffer.from(prefix, "binary"), frame()))).toBe("notAdts");
  },
);

it("leaves empty or one-byte input unidentified", () => {
  expect(admit("")).toBe("notAdts");
  expect(admit(file(Buffer.from([0xff])))).toBe("notAdts");
});

it.each(["ID3", "TAG", "ADIF"])(
  "leaves trailing/interleaved%s extent unknown",
  (tag) => {
    expect(admit(file(frame(), Buffer.from(tag), frame()))).toBe("notCovered");
    expect(
      admit(file(Buffer.from(F.LONG_601, "base64"), Buffer.from(tag))),
    ).toBe("audioTooLong");
  },
);

it.each([2, 3, 6])(
  "rejects an identified ADTS header truncated to%s bytes",
  (length) => {
    expect(admit(file(frame().subarray(0, length)))).toBe("invalid");
  },
);

it.each([0, 1, 6, 8191])(
  "rejects an impossible or escaped frame extent%s",
  (declaredLength) => {
    expect(admit(file(frame({ declaredLength })))).toBe("invalid");
  },
);

it("requires space for the CRC header without pretending to verify its value", () => {
  expect(admit(file(frame({ crc: true, declaredLength: 8 })))).toBe("invalid");
  expect(admit(file(frame({ crc: true, length: 9 })))).toBe("notCovered");
});

it("requires every subsequent bare frame to have sync and a complete header", () => {
  expect(admit(file(frame(), Buffer.from([0xff, 0xf9])))).toBe("invalid");
  const next = frame();
  next[1] |= 2;
  expect(admit(file(frame(), next))).toBe("invalid");
});

it("bounds records even when every frame has an unknown profile", () => {
  const f = frame({ profile: 0 });
  expect(admit(repeat(f, 65_536))).toBe("notCovered");
  expect(admit(repeat(f, 65_537))).toBe("audioTooComplex");
});

it("visits only bounded headers, not encoded payload or a full decoded buffer", () => {
  const data = repeat(frame({ length: 8191, rateIndex: 0 }), 2048);
  let reads = 0;
  const original = MessageRasterReader.prototype.u8;
  const spy = vi
    .spyOn(MessageRasterReader.prototype, "u8")
    .mockImplementation(function (this: MessageRasterReader, at) {
      reads++;
      return original.call(this, at);
    });
  const atobSpy = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw new Error("No full decoded buffer during admission");
  });
  try {
    expect(admit(data)).toBe("withinBudget");
    expect(reads).toBeLessThan(2048 * 20);
    expect(atobSpy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    atobSpy.mockRestore();
  }
});
