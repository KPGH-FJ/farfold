import { expect, it } from "vitest";
import { FMP4_CONTROLS as F } from "./message_mp4_fragment_fixtures.test-support";
import { messageMp4AudioAdmission as admit } from "./message_mp4_audio_admission";
import { attachmentMediaAdmission } from "./message_attachments";
import {
  mp4TestBox as box,
  mp4TestTrack,
  mp4TestU32 as u32,
} from "./message_mp4_audio_fixtures.test-support";

// Declaration-only fixtures below never enter an audio decoder. The two complete
// AVFoundation controls above are kept separate from opaque test mdat payloads.
const bytes = (parts: Buffer[]) => Buffer.concat(parts);
function full(kind: string, flags: number, parts: Buffer[], version = 0) {
  return box(kind, bytes([u32((version << 24) | flags), ...parts]));
}
function track(
  id = 1,
  {
    handler = "soun",
    scale = 1000,
    flags = 3,
    version = 0,
    duration = 0n,
    timeline = [] as [number, number][],
  } = {},
) {
  const body = Buffer.alloc(version === 1 ? 92 : 80);
  body.writeUInt32BE(id, version === 1 ? 16 : 8);
  return mp4TestTrack({
    handler,
    scale,
    duration,
    timeline,
    extraTrack: [full("tkhd", flags, [body], version)],
  });
}
const trex = (id = 1, duration = 0, version = 0) =>
  full("trex", 0, [u32(id), u32(1), u32(duration), u32(0), u32(0)], version);
function header(
  id = 1,
  {
    duration = undefined as number | undefined,
    empty = false,
    extraFlags = 0,
    version = 0,
    base = undefined as bigint | undefined,
    description = undefined as number | undefined,
    size = undefined as number | undefined,
    sampleFlags = undefined as number | undefined,
  } = {},
) {
  const parts = [u32(id)];
  let flags = 0x20000 | extraFlags;
  if (base !== undefined) {
    flags |= 1;
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(base);
    parts.push(b);
  }
  if (description !== undefined) {
    flags |= 2;
    parts.push(u32(description));
  }
  if (duration !== undefined) {
    flags |= 8;
    parts.push(u32(duration));
  }
  if (size !== undefined) {
    flags |= 0x10;
    parts.push(u32(size));
  }
  if (sampleFlags !== undefined) {
    flags |= 0x20;
    parts.push(u32(sampleFlags));
  }
  if (empty) flags |= 0x10000;
  return full("tfhd", flags, parts, version);
}
function run({
  count = 1,
  durations = undefined as number[] | undefined,
  sizes = false,
  extraFlags = 0,
  version = 0,
} = {}) {
  const fields: Buffer[] = [u32(count)];
  let flags = extraFlags;
  if (durations !== undefined) flags |= 0x100;
  if (sizes) flags |= 0x200;
  if (durations !== undefined || sizes) {
    for (let i = 0; i < count; i++) {
      if (durations !== undefined) fields.push(u32(durations[i] ?? 0));
      if (sizes) fields.push(u32(1));
    }
  }
  return full("trun", flags, fields, version);
}
const traf = (h = header(), runs = [run()], extra: Buffer[] = []) =>
  box("traf", bytes([h, ...runs, ...extra]));
const moof = (trafs = [traf()]) =>
  box("moof", bytes([full("mfhd", 0, [u32(1)]), ...trafs]));
function file({
  tracks = [track()],
  defaults = [trex()],
  fragments = [moof()],
} = {}) {
  return bytes([
    box("ftyp", bytes([Buffer.from("isom"), u32(0), Buffer.from("iso5")])),
    box("moov", bytes([...tracks, box("mvex", bytes(defaults))])),
    ...fragments,
    box("mdat", Buffer.from([0])),
  ]).toString("base64");
}
const common = (data: string, mimeType = "audio/mp4") =>
  attachmentMediaAdmission({
    kind: "audio",
    name: "controlled.mp4",
    mimeType,
    data,
  });

it("retains the complete short HLS remux as partial with its exact source", () => {
  expect(admit(F.SHORT_3)).toBe("notCovered");
  expect(common(F.SHORT_3)).toMatchObject({
    status: "available",
    media: { src: `data:audio/mp4;base64,${F.SHORT_3}` },
  });
});
it("rejects the complete independently decoded601second HLS remux", () => {
  expect(admit(F.LONG_601)).toBe("audioTooLong");
  expect(common(F.LONG_601)).toMatchObject({
    status: "rejected",
    reason: "audioTooLong",
  });
});
it.each([
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
])("checks actual fragmented signature across original MIME %s", (mime) => {
  expect(common(F.LONG_601, mime)).toMatchObject({
    status: "rejected",
    reason: "audioTooLong",
  });
});
it.each([
  [600000, "notCovered"],
  [600001, "audioTooLong"],
] as const)("uses exact fragment ticks at %s", (duration, result) => {
  expect(
    admit(
      file({ fragments: [moof([traf(header(1, { duration }), [run()])])] }),
    ),
  ).toBe(result);
});
it("uses trex duration when no tfhd or sample override exists", () => {
  expect(admit(file({ defaults: [trex(1, 600001)] }))).toBe("audioTooLong");
});
it("tfhd presence overrides trex", () => {
  expect(
    admit(
      file({
        defaults: [trex(1, 600001)],
        fragments: [moof([traf(header(1, { duration: 1 }))])],
      }),
    ),
  ).toBe("notCovered");
});
it("per-sample duration overrides both defaults", () => {
  expect(
    admit(
      file({
        defaults: [trex(1, 600001)],
        fragments: [
          moof([
            traf(header(1, { duration: 600001 }), [run({ durations: [1] })]),
          ]),
        ],
      }),
    ),
  ).toBe("notCovered");
});
it("keeps explicit tfhd zero unknown instead of guessing positive trex", () => {
  expect(
    admit(
      file({
        defaults: [trex(1, 600001)],
        fragments: [moof([traf(header(1, { duration: 0 }))])],
      }),
    ),
  ).toBe("notCovered");
});
it("keeps explicit sample zero unknown instead of substituting default", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(1, { duration: 600001 }), [run({ durations: [0] })]),
          ]),
        ],
      }),
    ),
  ).toBe("notCovered");
});
it.each([0, 1])(
  "supports tkhd v%s enabled flags without confusing them with FullBox0 flags",
  (version) => {
    expect(
      admit(
        file({
          tracks: [track(1, { flags: 3, version })],
          fragments: [moof([traf(header(1, { duration: 600001 }))])],
        }),
      ),
    ).toBe("audioTooLong");
  },
);
it("sums all trun in one traf", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(), [
              run({ durations: [300000] }),
              run({ durations: [300001] }),
            ]),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("sums all same-track traf in one moof", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(1, { duration: 300000 })),
            traf(header(1, { duration: 300001 })),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("sums same-track runs across fragments", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([traf(header(1, { duration: 300000 }))]),
          moof([traf(header(1, { duration: 300001 }))]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("does not add concurrent audio-track durations", () => {
  expect(
    admit(
      file({
        tracks: [track(1), track(2)],
        defaults: [trex(1), trex(2)],
        fragments: [
          moof([
            traf(header(1, { duration: 400000 })),
            traf(header(2, { duration: 400000 })),
          ]),
        ],
      }),
    ),
  ).toBe("notCovered");
});
it("does not borrow a video duration as audio", () => {
  expect(
    admit(
      file({
        tracks: [track(1), track(2, { handler: "vide" })],
        fragments: [
          moof([
            traf(header(1, { duration: 1 })),
            traf(header(2, { duration: 900000 })),
          ]),
        ],
      }),
    ),
  ).toBe("notCovered");
});
it("does not borrow a known scale for an unknown track ID", () => {
  expect(
    admit(file({ fragments: [moof([traf(header(2, { duration: 900000 }))])] })),
  ).toBe("notCovered");
});
it("rejects ambiguous duplicate audio/video track IDs", () => {
  expect(
    admit(file({ tracks: [track(1), track(1, { handler: "vide" })] })),
  ).toBe("invalid");
});
it("zero track ID is invalid rather than an alias", () => {
  expect(admit(file({ tracks: [track(0)] }))).toBe("invalid");
});
it("unknown tkhd version remains partial", () => {
  expect(
    admit(
      file({
        tracks: [track(1, { version: 2 })],
        fragments: [moof([traf(header(1, { duration: 900000 }))])],
      }),
    ),
  ).toBe("notCovered");
});
it("zero media timescale is never invented", () => {
  expect(
    admit(
      file({
        tracks: [track(1, { scale: 0 })],
        fragments: [moof([traf(header(1, { duration: 900000 }))])],
      }),
    ),
  ).toBe("notCovered");
});
it.each([{ extraFlags: 4 }, { version: 1 }])(
  "unknown tfhd declarations do not guess offsets %j",
  (opts) => {
    expect(
      admit(
        file({
          fragments: [moof([traf(header(1, { duration: 900000, ...opts }))])],
        }),
      ),
    ).toBe("notCovered");
  },
);
it.each([{ extraFlags: 2 }, { version: 2 }])(
  "unknown trun declarations do not guess offsets %j",
  (opts) => {
    expect(
      admit(
        file({
          fragments: [
            moof([traf(header(1, { duration: 900000 }), [run(opts)])]),
          ],
        }),
      ),
    ).toBe("notCovered");
  },
);
it("unknown run cannot hide a separately known long run", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(1, { duration: 1 }), [run({ version: 2 })]),
            traf(header(1, { duration: 600001 })),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("unknown track cannot hide another known long audio track", () => {
  expect(
    admit(
      file({
        tracks: [track(1, { version: 2 }), track(2)],
        defaults: [trex(1), trex(2)],
        fragments: [
          moof([
            traf(header(1, { duration: 1 })),
            traf(header(2, { duration: 600001 })),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("unknown trex does not hide an independent tfhd duration", () => {
  expect(
    admit(
      file({
        defaults: [trex(1, 0, 1)],
        fragments: [moof([traf(header(1, { duration: 600001 }))])],
      }),
    ),
  ).toBe("audioTooLong");
});
it("handles all known optional tfhd fields in their defined order", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(
              header(1, {
                duration: 600001,
                base: 0n,
                description: 1,
                size: 1,
                sampleFlags: 0,
              }),
            ),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("checks actual per-sample columns without reading mdat", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(), [
              run({
                count: 2,
                durations: [300000, 300001],
                sizes: true,
                version: 1,
              }),
            ]),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("does not expand huge default-duration sample counts into a loop", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(1, { duration: 1024 }), [run({ count: 0xffffffff })]),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("shares finite record budget with explicit sample tables", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([
            traf(header(1, { duration: 1 }), [
              run({ count: 65537, sizes: true }),
            ]),
          ]),
        ],
      }),
    ),
  ).toBe("audioTooComplex");
});
it("rejects a truncated known sample table", () => {
  const malformed = full("trun", 0x100, [u32(2), u32(1)]);
  expect(
    admit(file({ fragments: [moof([traf(header(), [malformed])])] })),
  ).toBe("invalid");
});
it("rejects duplicate tfhd headers in one traf", () => {
  expect(
    admit(
      file({
        fragments: [moof([box("traf", bytes([header(), header(), run()]))])],
      }),
    ),
  ).toBe("invalid");
});
it("does not derive samples from duration-is-empty with no sample runs", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([traf(header(1, { duration: 900000, empty: true }), [])]),
        ],
      }),
    ),
  ).toBe("notCovered");
});
it("rejects a known empty-duration header contradicted by positive sample count", () => {
  expect(
    admit(
      file({
        fragments: [
          moof([traf(header(1, { duration: 1, empty: true }), [run()])]),
        ],
      }),
    ),
  ).toBe("invalid");
});
it("keeps mixed classic/fragment declarations partial without double-counting", () => {
  expect(
    admit(
      file({
        tracks: [track(1, { duration: 400000n, timeline: [[1, 400000]] })],
        fragments: [moof([traf(header(1, { duration: 400000 }))])],
      }),
    ),
  ).toBe("notCovered");
});
it("does not turn a tfdt presentation gap into declared sample duration", () => {
  const gap = full("tfdt", 0, [u32(0xffffffff)]);
  expect(
    admit(
      file({
        fragments: [moof([traf(header(1, { duration: 1 }), [run()], [gap])])],
      }),
    ),
  ).toBe("notCovered");
});
