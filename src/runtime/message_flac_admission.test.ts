import { expect, it, vi } from "vitest";
import { messageFlacAdmission as admit } from "./message_flac_admission";
import { MessageRasterReader } from "./message_raster_reader";
import {
  MESSAGE_FLAC_TEST_DATA as F,
  flacMetadataBlock as block,
  flacTestFile as file,
} from "./message_flac_fixtures.test-support";

const encoded = (bytes: Buffer) => bytes.toString("base64");

it("admits the complete independently decoded tiny FLAC control", () => {
  expect(admit(F.TINY)).toBe("withinBudget");
});

it("refuses the complete independently decoded601-second FLAC before URL creation", () => {
  expect(admit(F.LONG_601)).toBe("audioTooLong");
});

it.each([0, 1, 4_800_000, 4_800_001])(
  "uses the declared interchannel total%s against the600-second policy",
  (totalSamples) => {
    expect(admit(encoded(file({ totalSamples })))).toBe(
      !totalSamples
        ? "notCovered"
        : totalSamples > 4_800_000
          ? "audioTooLong"
          : "withinBudget",
    );
  },
);

it("retains all36 total-sample bits rather than truncating to the low word", () => {
  expect(
    admit(
      encoded(file({ sampleRate: 1_048_575, totalSamples: 4_294_967_297 })),
    ),
  ).toBe("audioTooLong");
});

it.each([1, 2, 8])(
  "does not multiply the duration by%s channels",
  (channels) => {
    expect(admit(encoded(file({ channels, totalSamples: 4_800_000 })))).toBe(
      "withinBudget",
    );
  },
);

it.each([1, 8000, 44_100, 1_048_575])(
  "retains representable sample rate%s without inventing a codec restriction",
  (sampleRate) => {
    expect(
      admit(encoded(file({ sampleRate, totalSamples: sampleRate * 600 }))),
    ).toBe("withinBudget");
  },
);

it("leaves legal zero-rate non-time-axis FLAC uncovered", () => {
  expect(admit(encoded(file({ sampleRate: 0 })))).toBe("notCovered");
});

it.each([4, 12, 16, 32])(
  "retains supported%s-bit declaration precision",
  (bits) => {
    expect(admit(encoded(file({ bits })))).toBe("withinBudget");
  },
);

it.each([1, 2, 3])("rejects forbidden%s-bit STREAMINFO precision", (bits) => {
  expect(admit(encoded(file({ bits })))).toBe("invalid");
});

it.each([
  { minBlock: 0 },
  { minBlock: 15 },
  { maxBlock: 0 },
  { minBlock: 4096, maxBlock: 4095 },
  { minFrame: 12, maxFrame: 11 },
])("rejects contradictory or forbidden known declarations%j", (options) => {
  expect(admit(encoded(file(options)))).toBe("invalid");
});

it.each([
  { minBlock: 16, maxBlock: 65_535 },
  { minFrame: 0, maxFrame: 20 },
  { minFrame: 20, maxFrame: 0 },
])("does not reject optional unknown frame sizes%j", (options) => {
  expect(admit(encoded(file(options)))).toBe("withinBudget");
});

it.each([7, 126])(
  "keeps reserved metadata type%s compatible and uncovered",
  (type) => {
    expect(
      admit(
        encoded(file({ blocks: [{ type, data: Buffer.from([1, 2, 3]) }] })),
      ),
    ).toBe("notCovered");
    expect(
      admit(
        encoded(
          file({
            totalSamples: 4_800_001,
            blocks: [{ type, data: Buffer.alloc(0) }],
          }),
        ),
      ),
    ).toBe("audioTooLong");
  },
);

it.each([1, 2, 3, 4, 5, 6])(
  "skips bounded opaque metadata type%s without interpreting picture data or fetching URIs",
  (type) => {
    expect(
      admit(
        encoded(
          file({
            blocks: [
              { type, data: Buffer.from("https://example.invalid/no-fetch") },
            ],
          }),
        ),
      ),
    ).toBe("withinBudget");
  },
);

it("rejects forbidden metadata127 and duplicate STREAMINFO", () => {
  expect(
    admit(encoded(file({ blocks: [{ type: 127, data: Buffer.alloc(0) }] }))),
  ).toBe("invalid");
  expect(
    admit(encoded(file({ blocks: [{ type: 0, data: Buffer.alloc(34) }] }))),
  ).toBe("invalid");
});

it.each([33, 35])(
  "requires the exact34-byte STREAMINFO, not%s bytes",
  (length) => {
    expect(
      admit(
        encoded(
          Buffer.concat([
            Buffer.from("fLaC"),
            block(0, Buffer.alloc(length), true),
            Buffer.from([0xff, 0xf8]),
          ]),
        ),
      ),
    ).toBe("invalid");
  },
);

it("requires the first metadata block to be STREAMINFO", () => {
  expect(
    admit(
      encoded(
        Buffer.concat([
          Buffer.from("fLaC"),
          block(1, Buffer.alloc(0), true),
          Buffer.from([0xff, 0xf8]),
        ]),
      ),
    ),
  ).toBe("invalid");
});

it.each([4, 5, 7, 8, 41, 42])(
  "rejects the truncated%s-byte native FLAC control",
  (length) => {
    expect(
      admit(encoded(Buffer.from(F.TINY, "base64").subarray(0, length))),
    ).toBe("invalid");
  },
);

it("rejects an escaped metadata body and a missing final-metadata marker", () => {
  const escaped = file();
  escaped.writeUIntBE(0xff_ffff, 5, 3);
  expect(admit(encoded(escaped))).toBe("invalid");
  const missing = file();
  missing[4] &= 0x7f;
  expect(admit(encoded(missing))).toBe("invalid");
});

it.each(["", "fLa", "RIFF\0\0\0\0WAVE", "OggS", "ID3", "ftyp"])(
  "does not claim another container%j",
  (signature) => {
    expect(admit(encoded(Buffer.from(signature)))).toBe("notFlac");
  },
);

it.each([65_535, 65_536])(
  "charges%s extra bounded metadata headers",
  (count) => {
    const data = file({
      blocks: Array.from({ length: count }, () => ({
        type: 1,
        data: Buffer.alloc(0),
      })),
    });
    expect(admit(encoded(data))).toBe(
      count === 65_535 ? "withinBudget" : "audioTooComplex",
    );
  },
);

it("does not fully decode or scan a16MiB opaque picture payload", () => {
  const data = encoded(
    file({ blocks: [{ type: 6, data: Buffer.alloc(16 * 1024 * 1024 - 59) }] }),
  );
  const decode = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw new Error("unexpected full binary decode");
  });
  const original = MessageRasterReader.prototype.u8;
  let reads = 0;
  const read = vi
    .spyOn(MessageRasterReader.prototype, "u8")
    .mockImplementation(function (this: MessageRasterReader, at) {
      reads++;
      return original.call(this, at);
    });
  try {
    expect(admit(data)).toBe("withinBudget");
    expect(reads).toBeLessThan(100);
    expect(decode).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    decode.mockRestore();
  }
});
