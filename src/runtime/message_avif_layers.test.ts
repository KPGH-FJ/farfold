import { expect, it, vi } from "vitest";
import { MessageRasterReader } from "./message_raster_reader";
import { AvifContext } from "./message_avif_reader";
import { avifItems } from "./message_avif_items";
import { avifLayers } from "./message_avif_layers";
import { messageAvifAdmission } from "./message_avif_admission";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_AVIF_PROGRESSIVE_TEST_DATA as PROGRESSIVE } from "./message_avif_layers_fixtures.test-support";
import { MESSAGE_AVIF_TEST_DATA as F } from "./message_avif_fixtures.test-support";
import {
  avifBox as box,
  avifFile as file,
  avifMeta as meta,
  avifIspe as ispe,
  avifGrid as grid,
  u16,
  u32,
} from "./message_avif_builders.test-support";

// Synthetic declarations below are not encoded AV1/decoder-validity proof.
function layers(sizes = [1, 1, 1], wide = false, flags = wide ? 1 : 0) {
  return box("a1lx", Buffer.from([flags]), ...sizes.map(wide ? u32 : u16));
}
function oneLayered(size = ispe(1, 1), property = layers()) {
  return file(
    meta(
      [{ id: 1, properties: [1, 2], grid: Buffer.alloc(4) }],
      [size, property],
    ),
  );
}
function charge(data: string) {
  const context = new AvifContext(new MessageRasterReader(data));
  for (const box of context.boxes(0, context.reader.length))
    if (box.kind === "meta") avifItems(context, box);
  return context;
}

it("keeps the complete official two-layer color/alpha sample and counts each declared layer", () => {
  expect(messageAvifAdmission(PROGRESSIVE, true)).toBe("withinBudget");
  expect(charge(PROGRESSIVE).pixels).toBe(33 * 11 * 4);
});

it.each([false, true])(
  "counts fixed three-entry a1lx using wide=%s",
  (wide) => {
    for (const [sizes, expected] of [
      [[0, 0, 0], 1],
      [[1, 0, 0], 2],
      [[1, 1, 0], 3],
      [[1, 1, 1], 4],
    ] as const) {
      const data = oneLayered(ispe(1, 1), layers([...sizes], wide));
      expect(messageAvifAdmission(data, true)).toBe("withinBudget");
      expect(charge(data).pixels).toBe(expected);
    }
  },
);

it("admits exactly four selected-ispe canvases ×16Mi under the existing64Mi work policy", () => {
  expect(messageAvifAdmission(oneLayered(ispe(8192, 2048)), true)).toBe(
    "withinBudget",
  );
  expect(charge(oneLayered(ispe(8192, 2048))).pixels).toBe(67_108_864);
});

it("charges color and auxiliary alpha layers together", () => {
  const data = file(
    meta(
      [
        { id: 1, properties: [1, 2], grid: Buffer.alloc(4) },
        { id: 2, properties: [1, 2], grid: Buffer.alloc(4), auxiliary: 1 },
      ],
      [ispe(8192, 2048), layers()],
    ),
  );
  expect(messageAvifAdmission(data, true)).toBe("tooComplex");
});

it("charges a shared layer property independently for every item", () => {
  const items = Array.from({ length: 17 }, (_, i) => ({
    id: i + 1,
    properties: [1, 2],
    grid: Buffer.alloc(4),
  }));
  expect(
    messageAvifAdmission(
      file(meta(items.slice(0, 16), [ispe(1024, 1024), layers()])),
      true,
    ),
  ).toBe("withinBudget");
  expect(
    messageAvifAdmission(file(meta(items, [ispe(1024, 1024), layers()])), true),
  ).toBe("tooComplex");
});

it("multiplies declared layers by already-counted derived tile uses", () => {
  const data = file(
    meta(
      [
        {
          id: 1,
          kind: "grid",
          properties: [1],
          references: [2, 2],
          grid: grid(8192, 2048, 1, 2),
        },
        { id: 2, properties: [2, 3], grid: Buffer.alloc(4) },
      ],
      [ispe(8192, 2048), ispe(4096, 2048), layers()],
    ),
  );
  expect(messageAvifAdmission(data, true)).toBe("tooComplex");
});

it.each([0, 1, 2, 3, 0xffff])(
  "does not infer a smaller layer count from lsel=%s",
  (selection) => {
    const data = file(
      meta(
        [{ id: 1, properties: [1, 2, 3, 4], grid: Buffer.alloc(4) }],
        [
          ispe(1, 1),
          layers(),
          box("lsel", u16(selection)),
          box("a1op", Buffer.from([0])),
        ],
      ),
    );
    expect(messageAvifAdmission(data, true)).toBe("withinBudget");
    expect(charge(data).pixels).toBe(4);
  },
);

it.each([{ sizes: [0, 1, 0] }, { sizes: [1, 0, 1] }])(
  "rejects a known zero-terminated layer-size contradiction %j",
  ({ sizes }) => {
    expect(
      messageAvifAdmission(oneLayered(ispe(1, 1), layers(sizes)), true),
    ).toBe("invalid");
  },
);

it.each([0, 1, 6, 8, 12, 14])(
  "rejects a known 16-bit layer layout with %s payload bytes",
  (length) => {
    expect(
      messageAvifAdmission(
        oneLayered(ispe(1, 1), box("a1lx", Buffer.alloc(length))),
        true,
      ),
    ).toBe("invalid");
  },
);

it("rejects duplicate known layer declarations associated with one item", () => {
  expect(
    messageAvifAdmission(
      file(
        meta(
          [{ id: 1, properties: [1, 2, 3], grid: Buffer.alloc(4) }],
          [ispe(1, 1), layers(), layers()],
        ),
      ),
      true,
    ),
  ).toBe("invalid");
});

it("requires a positive final layer when definite local extents expose item length", () => {
  expect(
    messageAvifAdmission(oneLayered(ispe(1, 1), layers([4, 0, 0])), true),
  ).toBe("invalid");
  expect(
    messageAvifAdmission(oneLayered(ispe(1, 1), layers([5, 0, 0])), true),
  ).toBe("invalid");
});

it.each(["external", "item-offset", "unspecified-length"])(
  "does not assume exact local payload length for %s",
  (kind) => {
    const bytes = Buffer.from(
      oneLayered(ispe(1, 1), layers([500, 0, 0])),
      "base64",
    );
    const at = bytes.indexOf("iloc");
    if (kind === "external") bytes.writeUInt16BE(1, at + 16);
    else if (kind === "item-offset") bytes.writeUInt16BE(2, at + 14);
    else bytes.writeUInt32BE(0, at + 24);
    expect(messageAvifAdmission(bytes.toString("base64"), true)).toBe(
      kind === "unspecified-length" ? "withinBudget" : "notCovered",
    );
  },
);

it("keeps reserved future bits uncovered and continues other known canvas/work budgets", () => {
  expect(
    messageAvifAdmission(oneLayered(ispe(1, 1), layers([], false, 0x80)), true),
  ).toBe("notCovered");
  const items = [
    { id: 1, properties: [1, 2], grid: Buffer.alloc(4) },
    { id: 2, properties: [3, 4], grid: Buffer.alloc(4) },
  ];
  expect(
    messageAvifAdmission(
      file(
        meta(items, [
          ispe(1, 1),
          layers([], false, 0x80),
          ispe(8193, 1),
          layers(),
        ]),
      ),
      true,
    ),
  ).toBe("tooManyPixels");
  expect(
    messageAvifAdmission(
      file(
        meta(items, [
          ispe(1, 1),
          layers([], false, 0x80),
          ispe(8192, 2048),
          layers(),
        ]),
      ),
      true,
    ),
  ).toBe("tooComplex");
});

it("does not let a later reserved layer property erase an earlier known budget", () => {
  const data = file(
    meta(
      [{ id: 1, properties: [1, 2, 3], grid: Buffer.alloc(4) }],
      [ispe(1, 1), layers(), layers([], false, 0x80)],
    ),
  );
  expect(messageAvifAdmission(data, true)).toBe("notCovered");
  expect(charge(data).pixels).toBe(4);
});

it("preserves exact source/order-facing attachment values and checks actual AVIF across image MIME", () => {
  const data = file(
    meta(
      [
        { id: 1, properties: [1, 2], grid: Buffer.alloc(4) },
        { id: 2, properties: [1, 2], grid: Buffer.alloc(4) },
      ],
      [ispe(8192, 2048), layers()],
    ),
  );
  for (const mimeType of ["image/avif", "image/jpeg", "image/webp"]) {
    const attachment = {
      name: "Layer policy control",
      uri: "file:///owned/layered.avif",
      mimeType,
      data,
    };
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "rejected",
      reason: "tooComplex",
    });
    expect(JSON.stringify(attachment)).toBe(before);
  }
});

it("uses the Base64 metadata reader without a full decoder or binary conversion", () => {
  const atob = vi.spyOn(globalThis, "atob").mockImplementation(() => {
    throw new Error("No binary expansion");
  });
  try {
    expect(messageAvifAdmission(PROGRESSIVE, true)).toBe("withinBudget");
    expect(atob).not.toHaveBeenCalled();
  } finally {
    atob.mockRestore();
  }
});

it("adds no declared layers to an unchanged static image", () => {
  expect(messageAvifAdmission(F.STATIC, true)).toBe("withinBudget");
  expect(charge(F.STATIC).pixels).toBe(1);
});

it("charges layer-size entries against the same finite record budget", () => {
  const context = new AvifContext(
    new MessageRasterReader(layers().toString("base64")),
  );
  context.records = 65_535;
  const property = context.boxes(0, context.reader.length).next().value!;
  expect(() => avifLayers(context, property)).toThrowError("tooComplex");
});

it("keeps thousands of shared associations and layer properties linear and bounded", () => {
  const count = 5_000;
  const items = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    properties: [1, 2],
    grid: Buffer.alloc(4),
  }));
  const data = file(
    meta(items, [ispe(1, 1), ...Array.from({ length: count }, () => layers())]),
  );
  const read = MessageRasterReader.prototype.u8;
  let reads = 0;
  MessageRasterReader.prototype.u8 = function (at) {
    reads++;
    return read.call(this, at);
  };
  const started = performance.now();
  try {
    const context = charge(data);
    expect(context.pixels).toBe(count * 4);
    expect(context.records).toBeLessThanOrEqual(65_536);
    expect(reads).toBeLessThan(400_000);
    console.info(
      JSON.stringify({
        case: "5000-layer-properties-5000-items",
        reads,
        records: context.records,
        elapsedMs: performance.now() - started,
      }),
    );
  } finally {
    MessageRasterReader.prototype.u8 = read;
  }
});
