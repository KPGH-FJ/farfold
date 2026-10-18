import { expect, it, vi } from "vitest";
import { messageOggAudioAdmission as admit } from "./message_ogg_audio_admission";
import { MAX_MESSAGE_AUDIO_RECORDS } from "./message_audio_admission";
import { MessageRasterReader } from "./message_raster_reader";
import {
  MESSAGE_OGG_TEST_DATA as F,
  oggTestPage as page,
  oggTestPackets as packets,
  oggTestIdentification as identification,
  oggTestHeaders as headers,
} from "./message_ogg_audio_fixtures.test-support";

// These declarations test metadata policy, not CRC, setup or audio decoding.
// Only F.SHORT_2/F.LONG_610 are complete, independently decoded source controls.
const encode = (pages: Buffer[]) => Buffer.concat(pages).toString("base64");
const limit = 4_800_000n;
function audio(sequence: number, granule: bigint, flags = 0, serial = 1) {
  return page({
    sequence,
    granule,
    flags,
    serial,
    ...packets([Buffer.from([0])]),
  });
}
function interval({
  origin = 8000n,
  delta = limit + 1n,
  serial = 1,
  rate = 8000,
  terminalFlags = 4,
} = {}) {
  return [
    ...headers(serial, rate),
    audio(2, origin, 0, serial),
    audio(3, origin + delta, terminalFlags, serial),
  ];
}
const comment = Buffer.concat([Buffer.from("\x03vorbis"), Buffer.alloc(9)]);
const setup = Buffer.from("\x05vorbis\x01");

it("keeps the exact complete 2s source partial without an earlier audio anchor", () => {
  expect(admit(F.SHORT_2)).toBe("notCovered");
});
it("refuses the exact complete 610s source by its 602.096s declared subinterval", () => {
  expect(admit(F.LONG_610)).toBe("audioTooLong");
});
it("leaves other container signatures to the other admissions", () => {
  expect(admit(Buffer.from("RIFF1234WAVE").toString("base64"))).toBe(
    "notOggAudio",
  );
});
it.each([
  [limit, "notCovered"],
  [limit + 1n, "audioTooLong"],
] as const)(
  "compares the endpoint difference at %s ticks",
  (delta, expected) => {
    expect(admit(encode(interval({ delta })))).toBe(expected);
  },
);
it("cancels a large positive 64bit origin for a short declared interval", () => {
  expect(admit(encode(interval({ origin: 1n << 60n, delta: 16_000n })))).toBe(
    "notCovered",
  );
});
it("retains exact differences beyond Number's integer precision", () => {
  expect(admit(encode(interval({ origin: 1n << 60n })))).toBe("audioTooLong");
});
it("never uses header GP zero as an audio origin", () => {
  expect(admit(encode([...headers(), audio(2, 99_000_000n, 4)]))).toBe(
    "notCovered",
  );
});
it.each([-1n, -2n, -(1n << 63n)])(
  "does not reinterpret signed GP %s as a huge endpoint",
  (granule) => {
    expect(
      admit(encode([...headers(), audio(2, granule), audio(3, limit + 1n, 4)])),
    ).toBe("notCovered");
  },
);
it("uses a non-EOS endpoint to close an interval without declaring total coverage", () => {
  expect(admit(encode(interval({ terminalFlags: 0 })))).toBe("audioTooLong");
});
it("does not multiply a duration by the declared channel count", () => {
  const id = page({
    flags: 2,
    granule: 0n,
    ...packets([identification(8000, 255)]),
  });
  expect(
    admit(encode([id, headers()[1], audio(2, 8000n), audio(3, 3_208_000n, 4)])),
  ).toBe("notCovered");
});

it("tracks a comment packet spanning pages before setup and audio", () => {
  const longComment = Buffer.concat([
    comment,
    Buffer.alloc(300 - comment.length),
  ]);
  expect(
    admit(
      encode([
        headers()[0],
        page({ sequence: 1, laces: [255], body: longComment.subarray(0, 255) }),
        page({
          sequence: 2,
          flags: 1,
          granule: 0n,
          laces: [45, setup.length],
          body: Buffer.concat([longComment.subarray(255), setup]),
        }),
        audio(3, 8000n),
        audio(4, 8000n + limit + 1n, 4),
      ]),
    ),
  ).toBe("audioTooLong");
});
it("tracks setup across pages after a complete comment on its first page", () => {
  const longSetup = Buffer.concat([setup, Buffer.alloc(300 - setup.length)]);
  expect(
    admit(
      encode([
        headers()[0],
        page({
          sequence: 1,
          laces: [comment.length, 255],
          body: Buffer.concat([comment, longSetup.subarray(0, 255)]),
        }),
        page({
          sequence: 2,
          flags: 1,
          granule: 0n,
          laces: [45],
          body: longSetup.subarray(255),
        }),
        audio(3, 8000n),
        audio(4, 8000n + limit + 1n, 4),
      ]),
    ),
  ).toBe("audioTooLong");
});
it("leaves setup and first audio on one page outside the supported mapping", () => {
  expect(
    admit(
      encode([
        headers()[0],
        page({
          sequence: 1,
          granule: 8000n,
          ...packets([comment, setup, Buffer.from([0])]),
        }),
        audio(2, limit + 8001n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("recognizes the zero lace that completes a 255-byte audio packet", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({ sequence: 2, laces: [255], body: Buffer.alloc(255) }),
        page({ sequence: 3, flags: 1, granule: 8000n, laces: [0] }),
        audio(4, limit + 8001n, 4),
      ]),
    ),
  ).toBe("audioTooLong");
});
it("does not anchor on a continuation-only page even with a positive GP", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({
          sequence: 2,
          granule: 0n,
          laces: [255],
          body: Buffer.alloc(255),
        }),
        page({
          sequence: 3,
          flags: 1,
          granule: 8000n,
          laces: [255],
          body: Buffer.alloc(255),
        }),
        page({
          sequence: 4,
          flags: 5,
          granule: limit + 8001n,
          laces: [1],
          body: Buffer.from([0]),
        }),
      ]),
    ),
  ).toBe("notCovered");
});
it("does not anchor on a zero-segment page", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({ sequence: 2, granule: 0n }),
        audio(3, limit + 1n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("keeps a nil packet partial rather than declaring a container error", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({ sequence: 2, granule: 0n, laces: [0] }),
        audio(3, limit + 1n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("uses a completed packet before a trailing unfinished packet on the same page", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({
          sequence: 2,
          granule: 8000n,
          laces: [1, 255],
          body: Buffer.alloc(256),
        }),
        page({
          sequence: 3,
          flags: 5,
          granule: limit + 8001n,
          laces: [1],
          body: Buffer.from([0]),
        }),
      ]),
    ),
  ).toBe("audioTooLong");
});
it.each([
  ["sequence gap", () => audio(5, limit + 9000n, 4)],
  ["duplicate sequence", () => audio(3, limit + 9000n, 4)],
  ["reordered sequence", () => audio(2, limit + 9000n, 4)],
  ["unexpected continuation", () => audio(4, limit + 9000n, 5)],
  ["non-EOS GP regression", () => audio(4, 7999n)],
  ["EOS GP regression", () => audio(4, 7999n, 4)],
  ["unsupported negative terminal GP", () => audio(4, -1n, 4)],
  ["reserved page flags", () => audio(4, limit + 9000n, 12)],
] as const)("revokes an earlier candidate after a late %s", (_name, tail) => {
  expect(admit(encode([...interval({ terminalFlags: 0 }), tail()]))).toBe(
    "notCovered",
  );
});
it("revokes the epoch when a pending packet loses its continuation flag", () => {
  expect(
    admit(
      encode([
        ...interval({ terminalFlags: 0 }),
        page({ sequence: 4, laces: [255], body: Buffer.alloc(255) }),
        audio(5, limit + 9000n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("revokes the epoch when EOS leaves an unfinished packet", () => {
  expect(
    admit(
      encode([
        ...interval({ terminalFlags: 0 }),
        page({ sequence: 4, flags: 4, laces: [255], body: Buffer.alloc(255) }),
      ]),
    ),
  ).toBe("notCovered");
});
it("does not hide a truncated final page behind an earlier known excess", () => {
  const truncated = audio(4, limit + 9000n, 4).subarray(0, 28);
  expect(admit(encode([...interval({ terminalFlags: 0 }), truncated]))).toBe(
    "invalid",
  );
});
it("does not resynchronize through junk before a later Ogg signature", () => {
  expect(
    admit(
      encode([
        ...interval({ terminalFlags: 0 }),
        Buffer.from("junk"),
        audio(4, limit + 9000n, 4),
      ]),
    ),
  ).toBe("invalid");
});
it("treats an unsupported future page version as uncovered without guessing its extent", () => {
  expect(
    admit(encode([...interval({ terminalFlags: 0 }), page({ version: 1 })])),
  ).toBe("notCovered");
});

it("does not carry an earlier candidate through repeated BOS before EOS", () => {
  expect(
    admit(
      encode([
        ...interval({ terminalFlags: 0 }),
        ...headers(),
        audio(2, 16_000n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("retains a completed known-long epoch before an independent chained stream", () => {
  expect(
    admit(encode([...interval(), ...headers(), audio(2, 16_000n, 4)])),
  ).toBe("audioTooLong");
});
it("does not join the clocks of two short chained epochs reusing a serial", () => {
  expect(
    admit(
      encode([
        ...interval({ delta: 8_000n }),
        ...interval({ origin: 9_000_000n, delta: 16_000n, rate: 16_000 }),
      ]),
    ),
  ).toBe("notCovered");
});
it("does not continue a finished serial without a new BOS", () => {
  expect(admit(encode([...interval(), audio(4, limit + 9000n)]))).toBe(
    "notCovered",
  );
});
it("does not sum two multiplexed 400second clocks or use another stream's rate", () => {
  expect(
    admit(
      encode([
        ...headers(1, 8000),
        ...headers(2, 16_000),
        audio(2, 8000n, 0, 1),
        audio(2, 100_000_000n, 0, 2),
        audio(3, 3_208_000n, 4, 1),
        audio(3, 106_400_000n, 4, 2),
      ]),
    ),
  ).toBe("notCovered");
});
it.each(["before", "after"])(
  "does not let an unknown codec %s hide an independent known excess",
  (order) => {
    const unknown = page({
      serial: 2,
      flags: 6,
      granule: 1_000_000_000n,
      ...packets([Buffer.from("OpusHead")]),
    });
    const pages =
      order === "before" ? [unknown, ...interval()] : [...interval(), unknown];
    expect(admit(encode(pages))).toBe("audioTooLong");
  },
);
it("keeps another complete epoch's excess after one stream loses sequence continuity", () => {
  expect(
    admit(
      encode([
        ...interval({ serial: 2 }),
        ...interval({ terminalFlags: 0 }),
        audio(9, limit + 9000n, 4),
      ]),
    ),
  ).toBe("audioTooLong");
});
it.each([
  ["version", (p: Buffer) => p.writeUInt32LE(1, 7)],
  [
    "zero channels",
    (p: Buffer) => {
      p[11] = 0;
    },
  ],
  ["zero sample rate", (p: Buffer) => p.writeUInt32LE(0, 12)],
  [
    "too-small block",
    (p: Buffer) => {
      p[28] = 0xb5;
    },
  ],
  [
    "too-large block",
    (p: Buffer) => {
      p[28] = 0xe8;
    },
  ],
  [
    "reversed blocks",
    (p: Buffer) => {
      p[28] = 0x8b;
    },
  ],
  [
    "missing framing bit",
    (p: Buffer) => {
      p[29] = 0;
    },
  ],
  ["unknown codec signature", (p: Buffer) => p.write("xxxxxx", 1)],
] as const)(
  "leaves an unsupported identification %s partial",
  (_name, mutate) => {
    const id = identification();
    mutate(id);
    expect(
      admit(
        encode([
          page({ flags: 2, granule: 0n, ...packets([id]) }),
          headers()[1],
          audio(2, 8000n),
          audio(3, limit + 8001n, 4),
        ]),
      ),
    ).toBe("notCovered");
  },
);
it("requires ordered comment and setup packet signatures", () => {
  expect(
    admit(
      encode([
        headers()[0],
        page({ sequence: 1, ...packets([setup, comment]) }),
        audio(2, 8000n),
        audio(3, limit + 8001n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("requires identification to finish alone on the BOS page", () => {
  expect(
    admit(
      encode([
        page({
          flags: 2,
          granule: 0n,
          ...packets([identification(), comment]),
        }),
        page({ sequence: 1, ...packets([setup]) }),
        audio(2, 8000n),
        audio(3, limit + 8001n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("charges unknown streams to the same finite page and lacing allowance", () => {
  const unknown = Array.from(
    { length: Math.floor(MAX_MESSAGE_AUDIO_RECORDS / 2) + 1 },
    (_, serial) => page({ serial, flags: 6, laces: [0] }),
  );
  expect(admit(encode(unknown))).toBe("audioTooComplex");
});
it("shares work across separate streams rather than resetting per serial", () => {
  const empty = Array.from({ length: MAX_MESSAGE_AUDIO_RECORDS }, (_, serial) =>
    page({ serial }),
  );
  expect(admit(encode([...interval(), ...empty]))).toBe("audioTooComplex");
});
it("skips a large multi-page header body with bounded prefix reads and no decoder", () => {
  const fullLaces = Array.from({ length: 255 }, () => 255);
  const body = Buffer.alloc(255 * 255);
  const longComment = Buffer.from(body);
  comment.copy(longComment);
  const pages = [
    headers()[0],
    page({ sequence: 1, laces: fullLaces, body: longComment }),
  ];
  for (let sequence = 2; sequence < 18; sequence++)
    pages.push(page({ sequence, flags: 1, laces: fullLaces, body }));
  pages.push(
    page({ sequence: 18, flags: 1, laces: [0, setup.length], body: setup }),
    audio(19, 8000n),
    audio(20, limit + 8001n, 4),
  );
  const input = encode(pages);
  const reads = vi.spyOn(MessageRasterReader.prototype, "u8");
  const decode = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw new Error("Unexpected whole-body decode");
  });
  try {
    expect(admit(input)).toBe("audioTooLong");
    expect(reads.mock.calls.length).toBeLessThan(10_000);
    expect(decode).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    decode.mockRestore();
  }
});
