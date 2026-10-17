import { afterEach, expect, it, vi } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import { MessageRasterReader } from "./message_raster_reader";
import { MESSAGE_AVIF_TEST_DATA as F } from "./message_avif_fixtures.test-support";
import {
  AVIF_FTYP,
  avifBox as box,
  avifFull as full,
  avifFile as file,
  avifIspe as ispe,
  avifMeta as meta,
  avifGrid as grid,
  avifTrack as track,
  u16,
  u32,
} from "./message_avif_builders.test-support";

afterEach(() => vi.restoreAllMocks());
const admit = (bytes: Buffer) =>
  messageAvifAdmission(bytes.toString("base64"), false);
const single = () => meta([{ id: 1, properties: [1] }], [ispe(1, 1)]);

it.each([
  [8192, 2048, "withinBudget"],
  [8193, 1, "tooManyPixels"],
  [8192, 2049, "tooManyPixels"],
  [0, 1, "invalid"],
] as const)(
  "checks each declared canvas at %s by %s",
  (width, height, expected) => {
    expect(
      messageAvifAdmission(
        file(meta([{ id: 1, properties: [1] }], [ispe(width, height)])),
        true,
      ),
    ).toBe(expected);
  },
);

it("charges a shared ispe independently for every associated image", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    properties: [1],
  }));
  expect(
    messageAvifAdmission(
      file(meta(items.slice(0, 4), [ispe(8192, 2048)])),
      true,
    ),
  ).toBe("withinBudget");
  expect(
    messageAvifAdmission(file(meta(items, [ispe(8192, 2048)])), true),
  ).toBe("tooComplex");
});

it("charges grid output and every repeated tile use without traversing property × item pairs", () => {
  const items = [
    {
      id: 1,
      kind: "grid",
      properties: [1],
      references: [2, 2],
      grid: grid(8192, 2048, 1, 2),
    },
    { id: 2, properties: [2] },
  ];
  expect(
    messageAvifAdmission(
      file(meta(items, [ispe(8192, 2048), ispe(4096, 2048)])),
      true,
    ),
  ).toBe("withinBudget");
  // Five independent large roots which reuse one property exceed the work sum.
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    properties: [1],
  }));
  expect(messageAvifAdmission(file(meta(many, [ispe(8192, 2048)])), true)).toBe(
    "tooComplex",
  );
});

it("rejects the grid payload's excessive output before trusting the smaller ispe", () => {
  const items = [
    {
      id: 1,
      kind: "grid",
      properties: [1],
      references: [2],
      grid: grid(8193, 1, 1, 1, true),
    },
    { id: 2, properties: [1] },
  ];
  expect(messageAvifAdmission(file(meta(items, [ispe(1, 1)])), true)).toBe(
    "tooManyPixels",
  );
});

it.each([
  [grid(2, 1), [2], [ispe(2, 1), ispe(1, 1)]],
  [grid(2, 1, 1, 2), [2], [ispe(2, 1), ispe(1, 1)]],
  [grid(2, 1, 1, 2), [2, 3], [ispe(2, 1), ispe(1, 1), ispe(2, 1)]],
] as const)(
  "rejects known grid count/coverage/tile-size contradictions",
  (payload, refs, properties) => {
    const items = [
      {
        id: 1,
        kind: "grid",
        properties: [1],
        references: [...refs],
        grid: payload,
      },
      { id: 2, properties: [2] },
      ...(properties.length > 2 ? [{ id: 3, properties: [3] }] : []),
    ];
    expect(messageAvifAdmission(file(meta(items, [...properties])), true)).toBe(
      "invalid",
    );
  },
);

it("checks independent oversized auxiliary declarations despite a tiny primary", () => {
  expect(
    messageAvifAdmission(
      file(
        meta(
          [
            { id: 1, properties: [1] },
            { id: 2, properties: [2], auxiliary: 1 },
          ],
          [ispe(1, 1), ispe(8193, 1)],
        ),
      ),
      true,
    ),
  ).toBe("tooManyPixels");
});

it("requires known AV1 item size associations instead of treating missing sizes as safe", () => {
  expect(
    messageAvifAdmission(file(meta([{ id: 1 }], [ispe(1, 1)])), true),
  ).toBe("invalid");
});

it("rejects cyclic image derivations without recursive graph traversal", () => {
  expect(
    messageAvifAdmission(
      file(
        meta(
          [
            { id: 1, properties: [1], references: [2] },
            { id: 2, properties: [1], references: [1] },
          ],
          [ispe(1, 1)],
        ),
      ),
      true,
    ),
  ).toBe("invalid");
});

it("caps exponentially reused image declarations with a linear reference walk", () => {
  const items = Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    properties: [1],
    ...(index < 17 ? { references: [index + 2, index + 2] } : {}),
  }));
  expect(messageAvifAdmission(file(meta(items, [ispe(1, 1)])), true)).toBe(
    "tooComplex",
  );
});

it("continues known dimensions after an unknown item-info version", () => {
  const bytes = Buffer.from(
    file(meta([{ id: 1, properties: [1] }], [ispe(1, 1)])),
    "base64",
  );
  bytes[bytes.indexOf("infe") + 4] = 7;
  expect(admit(bytes)).toBe("notCovered");
  bytes.writeUInt32BE(8193, bytes.indexOf("ispe") + 8);
  expect(admit(bytes)).toBe("tooManyPixels");
});

it("continues known dimensions after unknown associations and property versions", () => {
  const properties = [full("ispe", 1, 0, u32(1), u32(1)), ispe(1, 1)];
  const bytes = Buffer.from(
    file(
      meta(
        [
          { id: 1, properties: [1] },
          { id: 2, properties: [2] },
        ],
        properties,
      ),
    ),
    "base64",
  );
  expect(admit(bytes)).toBe("notCovered");
  bytes.writeUInt32BE(8193, bytes.lastIndexOf("ispe") + 8);
  expect(admit(bytes)).toBe("tooManyPixels");
  bytes[bytes.indexOf("ipma") + 4] = 8;
  expect(admit(bytes)).toBe("tooManyPixels");
});

it("skips opaque extensions while still inspecting later known metadata", () => {
  expect(
    messageAvifAdmission(
      file(
        box("uuid", Buffer.alloc(16)),
        box("free", Buffer.alloc(64)),
        single(),
      ),
      true,
    ),
  ).toBe("withinBudget");
  const futureMeta = full("meta", 9, 0, Buffer.from([0, 1]));
  expect(
    messageAvifAdmission(
      file(futureMeta, box("moov", track(8193, 1, 1))),
      true,
    ),
  ).toBe("tooManyPixels");
  expect(messageAvifAdmission(file(futureMeta), true)).toBe("notCovered");
});

it("keeps a bounded unknown derived image layout uncovered", () => {
  expect(
    messageAvifAdmission(
      file(meta([{ id: 1, kind: "tmap", properties: [1] }], [ispe(1, 1)])),
      true,
    ),
  ).toBe("notCovered");
});

it("keeps unknown properties compatible while checking later known excessive sizes", () => {
  expect(
    messageAvifAdmission(
      file(meta([{ id: 1, properties: [1, 2] }], [box("zNEW"), ispe(1, 1)])),
      true,
    ),
  ).toBe("notCovered");
  expect(
    messageAvifAdmission(
      file(meta([{ id: 1, properties: [1, 2] }], [box("zNEW"), ispe(8193, 1)])),
      true,
    ),
  ).toBe("tooManyPixels");
});

it("does not call unassociated properties alone an admitted image item", () => {
  expect(messageAvifAdmission(file(meta([], [ispe(1, 1)])), true)).toBe(
    "invalid",
  );
});

it.each([0, 1, 128, 129])(
  "counts %s container samples against the shared frame budget",
  (samples) => {
    expect(
      messageAvifAdmission(file(box("moov", track(1, 1, samples))), true),
    ).toBe(
      samples > 128 ? "tooComplex" : samples ? "withinBudget" : "notCovered",
    );
  },
);

it("checks complete declared sample canvas × count at and above 64Mi pixels", () => {
  expect(
    messageAvifAdmission(file(box("moov", track(1024, 1024, 64))), true),
  ).toBe("withinBudget");
  expect(
    messageAvifAdmission(file(box("moov", track(1024, 1024, 65))), true),
  ).toBe("tooComplex");
});

it("checks every visual sample description rather than trusting the first", () => {
  const sample = (width: number) => {
    const bytes = Buffer.alloc(78);
    bytes.writeUInt16BE(width, 24);
    bytes.writeUInt16BE(1, 26);
    return box("av01", bytes);
  };
  const stsd = full("stsd", 0, 0, u32(2), sample(1), sample(8193));
  expect(
    messageAvifAdmission(file(box("moov", track(1, 1, 1, { stsd }))), true),
  ).toBe("tooManyPixels");
});

it("does not let unrelated unknown metadata waive a missing known track identity", () => {
  const data = Buffer.from(file(box("moov", track(1, 1, 1))), "base64");
  const at = data.indexOf("tkhd") - 4,
    size = data.readUInt32BE(at);
  const changed = Buffer.concat([
    data.subarray(0, at),
    data.subarray(at + size),
  ]);
  changed.writeUInt32BE(
    changed.readUInt32BE(AVIF_FTYP.length) - size,
    AVIF_FTYP.length,
  );
  changed.writeUInt32BE(
    changed.readUInt32BE(AVIF_FTYP.length + 8) - size,
    AVIF_FTYP.length + 8,
  );
  const unknown = full("meta", 5, 0);
  expect(admit(Buffer.concat([changed, unknown]))).toBe("invalid");
});

it.each([4, 8, 16])("supports the compact %s-bit sample table", (bits) => {
  const sampleBox = full(
    "stz2",
    0,
    0,
    Buffer.from([0, 0, 0, bits]),
    u32(3),
    Buffer.alloc(Math.ceil((3 * bits) / 8)),
  );
  expect(
    messageAvifAdmission(
      file(box("moov", track(1, 1, 3, { sampleBox }))),
      true,
    ),
  ).toBe("withinBudget");
});

it("rejects contradictory sample counts and incomplete compact tables", () => {
  expect(
    messageAvifAdmission(
      file(box("moov", track(1, 1, 2, { timedSamples: 3 }))),
      true,
    ),
  ).toBe("invalid");
  const sampleBox = full(
    "stz2",
    0,
    0,
    Buffer.from([0, 0, 0, 16]),
    u32(3),
    Buffer.alloc(5),
  );
  expect(
    messageAvifAdmission(
      file(box("moov", track(1, 1, 3, { sampleBox }))),
      true,
    ),
  ).toBe("invalid");
});

it("charges fragment samples together with the initial sample table", () => {
  const fragment = (count: number) =>
    box(
      "moof",
      box("traf", full("tfhd", 0, 0, u32(1)), full("trun", 0, 0, u32(count))),
    );
  expect(
    messageAvifAdmission(
      file(box("moov", track(1, 1, 1)), fragment(127)),
      true,
    ),
  ).toBe("withinBudget");
  expect(
    messageAvifAdmission(
      file(box("moov", track(1, 1, 1)), fragment(128)),
      true,
    ),
  ).toBe("tooComplex");
});

it.each(["stsd", "stsz", "stts"])(
  "retains unknown %s layout without skipping a later known oversized track",
  (kind) => {
    const first = track(1, 1, 1),
      second = track(8193, 1, 1, { id: 2 });
    first[first.indexOf(kind) + 4] = 7;
    expect(messageAvifAdmission(file(box("moov", first, second)), true)).toBe(
      "tooManyPixels",
    );
  },
);

it.each(["tkhd", "stsd", "stsz", "ipma", "iinf"])(
  "rejects known truncated %s declarations",
  (kind) => {
    const source = Buffer.from(
      kind === "ipma" || kind === "iinf"
        ? file(single())
        : file(box("moov", track(1, 1, 1))),
      "base64",
    );
    const at = source.indexOf(kind) - 4;
    source.writeUInt32BE(9, at);
    expect(admit(source)).toBe("invalid");
  },
);

it.each([
  box("free", Buffer.alloc(8)).subarray(0, 7),
  Buffer.concat([u32(1), Buffer.from("free"), u32(1), u32(16)]),
  Buffer.concat([u32(7), Buffer.from("free")]),
  Buffer.concat([u32(99), Buffer.from("free")]),
  box("uuid"),
])("rejects escaped/truncated/invalid-sized box headers", (bad) => {
  expect(messageAvifAdmission(file(single(), bad), true)).toBe("invalid");
});

it("supports bounded extended and parent-sized zero boxes", () => {
  const extended = Buffer.concat([
    u32(1),
    Buffer.from("free"),
    u32(0),
    u32(16),
  ]);
  const remainder = Buffer.concat([
    u32(0),
    Buffer.from("mdat"),
    Buffer.alloc(2),
  ]);
  expect(messageAvifAdmission(file(single(), extended, remainder), true)).toBe(
    "withinBudget",
  );
});

it("caps deeply nested structural containers", () => {
  let inside: Buffer = Buffer.alloc(0);
  for (let index = 0; index < 17; index++) inside = box("mdia", inside);
  expect(
    messageAvifAdmission(file(box("moov", box("trak", inside))), true),
  ).toBe("tooComplex");
});

it("caps record work before allocating huge property/association tables", () => {
  const data = Buffer.from(file(single()), "base64");
  data.writeUInt32BE(0xffff_ffff, data.indexOf("ipma") + 8);
  expect(admit(data)).toBe("tooComplex");
});

it("does not decode or scan an opaque 16MiB payload", () => {
  const first = Buffer.from(F.STATIC, "base64");
  const padding = box(
    "free",
    Buffer.alloc(16 * 1024 * 1024 - first.length - 8),
  );
  const encoded = Buffer.concat([first, padding]).toString("base64");
  const reads = vi.spyOn(MessageRasterReader.prototype, "u8");
  const atob = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw new Error("No full binary decode");
  });
  expect(messageAvifAdmission(encoded, true)).toBe("withinBudget");
  expect(reads.mock.calls.length).toBeLessThan(2_000);
  expect(atob).not.toHaveBeenCalled();
});
