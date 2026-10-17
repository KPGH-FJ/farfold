import { expect, it } from "vitest";
import { messageMp4AudioAdmission as admit } from "./message_mp4_audio_admission";
import {
  MESSAGE_MP4_AUDIO_TEST_DATA as F,
  mp4AudioTestBytes,
  mp4AudioTestFile,
  mp4TestBox,
  mp4TestMdhd,
  mp4TestStts,
  mp4TestTrack,
  mp4TestU32,
  type Mp4AudioTestTrack,
} from "./message_mp4_audio_fixtures.test-support";

const file = (options: Mp4AudioTestTrack = {}) =>
  mp4AudioTestFile({ tracks: [mp4TestTrack(options)] });

it("rejects the actual complete 601-second CoreAudio M4A", () => {
  expect(admit(F.LONG_601)).toBe("audioTooLong");
});
it("keeps the actual complete short M4A inside its declaration budget", () => {
  expect(admit(F.SHORT_3)).toBe("withinBudget");
});
it("does not mistake a different container or a mere label for MP4", () => {
  expect(admit(Buffer.from("RIFF\0\0\0\0WAVE").toString("base64"))).toBe(
    "notMp4Audio",
  );
});
it.each([
  [600_000n, "withinBudget"],
  [600_001n, "audioTooLong"],
] as const)(
  "uses an exact 600-second media-clock boundary at %s ticks",
  (ticks, result) => {
    expect(
      admit(
        file({ scale: 1000, duration: ticks, timeline: [[Number(ticks), 1]] }),
      ),
    ).toBe(result);
  },
);
it("retains a version-1 duration above Number safe integer without rounding", () => {
  expect(
    admit(file({ mdhdVersion: 1, duration: 9_007_199_254_740_993n })),
  ).toBe("audioTooLong");
});
it("does not mistake 64-bit all-ones for known long audio", () => {
  expect(
    admit(file({ mdhdVersion: 1, duration: 0xffff_ffff_ffff_ffffn })),
  ).toBe("notCovered");
});
it.each([0n, 0xffff_ffffn])("keeps mdhd sentinel %s unknown", (duration) => {
  expect(admit(file({ duration }))).toBe("notCovered");
});
it.each([0n, 0xffff_ffffn])(
  "still checks known stts despite mdhd sentinel %s",
  (duration) => {
    expect(admit(file({ duration, timeline: [[601, 1]] }))).toBe(
      "audioTooLong",
    );
  },
);
it("never invents a time scale for a zero-scale track", () => {
  expect(
    admit(file({ scale: 0, duration: 99999n, timeline: [[99999, 1]] })),
  ).toBe("notCovered");
});
it("keeps known short disagreement uncovered instead of choosing the smaller duration", () => {
  expect(admit(file({ duration: 599n }))).toBe("notCovered");
});
it.each([
  { duration: 601n, timeline: [[1, 1]] },
  { duration: 1n, timeline: [[601, 1]] },
] as Mp4AudioTestTrack[])(
  "checks each independently known clock before mismatch fallback",
  (options) => {
    expect(admit(file(options))).toBe("audioTooLong");
  },
);
it("sums multiple stts runs with integer multiplication", () => {
  expect(
    admit(
      file({
        duration: 600n,
        timeline: [
          [300, 1],
          [150, 2],
        ],
      }),
    ),
  ).toBe("withinBudget");
  expect(
    admit(
      file({
        duration: 600n,
        timeline: [
          [300, 1],
          [151, 2],
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it("does not expand huge sample counts into loops or arrays", () => {
  expect(
    admit(file({ duration: 1n, timeline: [[0xffff_ffff, 0xffff_ffff]] })),
  ).toBe("audioTooLong");
});
it("keeps zero-duration table entries uncovered while retaining known positive work", () => {
  expect(
    admit(
      file({
        timeline: [
          [600, 1],
          [1, 0],
        ],
      }),
    ),
  ).toBe("notCovered");
  expect(
    admit(
      file({
        duration: 0n,
        timeline: [
          [1, 0],
          [601, 1],
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it.each([{ timeline: [] }, { timeline: [[0, 1]] }, { timeline: [[1, 0]] }] as {
  timeline: readonly (readonly [number, number])[];
}[])("does not certify an empty or zero-duration stts", ({ timeline }) =>
  expect(admit(file({ duration: 0n, timeline }))).toBe("notCovered"),
);
it.each([
  { mdhdVersion: 2 },
  { mdhdFlags: 1 },
  { sttsVersion: 1 },
  { sttsFlags: 1 },
  { handlerVersion: 1 },
  { noHeader: true },
  { noInfo: true },
  { noHandler: true },
  { timeline: null },
] as Mp4AudioTestTrack[])(
  "preserves an unimplemented timing layout without guessing",
  (options) => {
    expect(admit(file(options))).toBe("notCovered");
  },
);
it("does not let an unknown sample table erase an independent known mdhd excess", () => {
  expect(admit(file({ duration: 601n, sttsVersion: 1 }))).toBe("audioTooLong");
});
it.each(["vide", "pict", "meta", "zzzz"])(
  "does not classify %s timing as audio",
  (handler) => {
    expect(
      admit(file({ handler, duration: 999999n, timeline: [[999999, 1]] })),
    ).toBe("notCovered");
  },
);
it("does not multiply parallel audio tracks into elapsed time", () => {
  const short = mp4TestTrack({ duration: 400n, timeline: [[400, 1]] });
  expect(admit(mp4AudioTestFile({ tracks: [short, short] }))).toBe(
    "withinBudget",
  );
});
it("does not mistake movie timing or sample-entry channels for an audio clock", () => {
  const sampleEntry = mp4TestBox("stsd", Buffer.alloc(64, 0xff));
  expect(
    admit(
      mp4AudioTestFile({
        tracks: [mp4TestTrack({ extraTable: [sampleEntry] })],
        extraMovie: [mp4TestBox("mvhd", Buffer.alloc(100, 0xff))],
      }),
    ),
  ).toBe("withinBudget");
});
it.each([
  { tracks: [mp4TestTrack({ edit: true })] },
  { fragment: true },
  { brands: ["zzzz"] },
  { noMovie: true },
  { noMedia: true },
  { tracks: [] },
])("keeps unsupported presentation or missing timing uncovered", (options) => {
  expect(admit(mp4AudioTestFile(options))).toBe("notCovered");
});
it.each([
  { tracks: [mp4TestTrack({ edit: true, duration: 601n })] },
  { tracks: [mp4TestTrack({ duration: 601n })], fragment: true },
  { tracks: [mp4TestTrack({ duration: 601n })], brands: ["zzzz"] },
])(
  "does not let unsupported presentation erase known over-budget media",
  (options) => {
    expect(admit(mp4AudioTestFile(options))).toBe("audioTooLong");
  },
);
it("does not let an earlier unknown track hide a later known long one", () => {
  expect(
    admit(
      mp4AudioTestFile({
        tracks: [
          mp4TestTrack({ mdhdVersion: 2 }),
          mp4TestTrack({ duration: 601n }),
        ],
      }),
    ),
  ).toBe("audioTooLong");
});
it.each([
  { extraMedia: [mp4TestMdhd()] },
  { extraTable: [mp4TestStts([[600, 1]])] },
  { extraTrack: [mp4TestBox("mdia")] },
] as Mp4AudioTestTrack[])(
  "rejects duplicate required timing owners",
  (options) => {
    expect(admit(file(options))).toBe("invalid");
  },
);
it("rejects duplicate movie and file-type boxes", () => {
  expect(admit(mp4AudioTestFile({ extraTop: [mp4TestBox("moov")] }))).toBe(
    "invalid",
  );
  expect(admit(mp4AudioTestFile({ extraTop: [mp4TestBox("ftyp")] }))).toBe(
    "invalid",
  );
});
it("checks table record count against its exact bounded payload", () => {
  const malformed = mp4TestBox(
    "stts",
    Buffer.concat([mp4TestU32(0), mp4TestU32(2), Buffer.alloc(8)]),
  );
  expect(admit(file({ timeline: null, extraTable: [malformed] }))).toBe(
    "invalid",
  );
});
it("rejects truncated known headers without reading the next box", () => {
  expect(
    admit(
      file({
        noHeader: true,
        extraMedia: [mp4TestBox("mdhd", Buffer.alloc(4))],
      }),
    ),
  ).toBe("invalid");
});
it("checks parent extents and extended-size bounds before traversing children", () => {
  const bytes = mp4AudioTestBytes();
  bytes.writeUInt32BE(bytes.length + 1, 0);
  expect(admit(bytes.toString("base64"))).toBe("invalid");
  const extended = Buffer.concat([
    mp4TestU32(1),
    Buffer.from("ftyp"),
    Buffer.alloc(8, 0xff),
  ]);
  expect(admit(extended.toString("base64"))).toBe("invalid");
});
it("accepts a bounded extended-size top-level opaque box", () => {
  expect(
    admit(
      mp4AudioTestFile({
        extraTop: [mp4TestBox("free", Buffer.alloc(3), { extended: true })],
      }),
    ),
  ).toBe("withinBudget");
});
it("allows size-zero only for the last top-level box", () => {
  const bytes = mp4AudioTestBytes({ noMedia: true });
  expect(
    admit(
      Buffer.concat([
        bytes,
        mp4TestBox("mdat", Buffer.alloc(4), { zero: true }),
      ]).toString("base64"),
    ),
  ).toBe("withinBudget");
  expect(
    admit(
      mp4AudioTestFile({
        extraMovie: [mp4TestBox("free", Buffer.alloc(0), { zero: true })],
      }),
    ),
  ).toBe("invalid");
});
it("skips opaque mdat and leaf payload instead of scanning them as timing", () => {
  const fake = mp4TestTrack({ duration: 999999n });
  expect(
    admit(
      mp4AudioTestFile({
        extraTop: [
          mp4TestBox("mdat", fake),
          mp4TestBox("uuid", Buffer.concat([Buffer.alloc(16), fake])),
        ],
      }),
    ),
  ).toBe("withinBudget");
});
it("shares the exact box and table record budget", () => {
  const free = mp4TestBox("free");
  expect(
    admit(
      mp4AudioTestFile({
        extraTop: Array.from({ length: 65_523 }, () => free),
      }),
    ),
  ).toBe("withinBudget");
  expect(
    admit(
      mp4AudioTestFile({
        extraTop: Array.from({ length: 65_524 }, () => free),
      }),
    ),
  ).toBe("audioTooComplex");
});
it("bounds compact table entry traversal before iteration", () => {
  const timeline = Array.from({ length: 65_525 }, () => [0, 0] as const);
  expect(admit(file({ duration: 0n, timeline }))).toBe("audioTooComplex");
});
it("also bounds file-type brand records", () => {
  expect(
    admit(
      mp4AudioTestFile({
        brands: Array.from({ length: 65_536 }, () => "isom"),
      }),
    ),
  ).toBe("audioTooComplex");
});
