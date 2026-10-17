import { expect, it } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_AVIF_TEST_DATA } from "./message_avif_fixtures.test-support";
import { MESSAGE_AVIF_PROGRESSIVE_TEST_DATA } from "./message_avif_layers_fixtures.test-support";
import {
  avifBox,
  avifFile,
  avifFull,
  avifIspe,
  avifMeta,
  u16,
  u32,
} from "./message_avif_builders.test-support";

const admit = (data: string) => messageAvifAdmission(data, true);
const original = Buffer.from(MESSAGE_AVIF_TEST_DATA.STATIC, "base64");
function changedStatic(field: number, value: number): string {
  const data = Buffer.from(original);
  data.writeUInt32BE(value, field);
  return data.toString("base64");
}

it("retains complete official file and idat progressive controls", () => {
  expect(original.length).toBe(305);
  expect(original.readUInt32BE(120)).toBe(282);
  expect(original.readUInt32BE(124)).toBe(23);
  expect(admit(original.toString("base64"))).toBe("withinBudget");
  expect(admit(MESSAGE_AVIF_PROGRESSIVE_TEST_DATA)).toBe("withinBudget");
});

it.each([
  [120, 306],
  [124, 24],
])(
  "rejects a known local coded-image range beyond the file (%s)",
  (field, value) => {
    expect(admit(changedStatic(field, value))).toBe("invalid");
  },
);

// Declaration-only layouts: not AV1 bitstreams or decoder acceptance evidence.
function layout({
  method = 1,
  reference = 0,
  base = 0,
  extents = [[0, 4]],
  idat = true,
  version = 1,
}: {
  method?: number;
  reference?: number;
  base?: number;
  extents?: number[][];
  idat?: boolean;
  version?: number;
} = {}): string {
  const location = avifFull(
    "iloc",
    version,
    0,
    Buffer.from([0x44, 0x40]),
    u16(1),
    u16(1),
    u16(method),
    u16(reference),
    u32(base),
    u16(extents.length),
    ...extents.flatMap(([offset, length]) => [u32(offset), u32(length)]),
  );
  return avifFile(
    avifMeta(
      [{ id: 1, properties: [1] }],
      [avifIspe(1, 1)],
      [location, ...(idat ? [avifBox("idat", Buffer.alloc(4))] : [])],
    ),
  );
}

it.each([
  { extents: [[0, 4]] },
  { base: 1, extents: [[1, 2]] },
  {
    extents: [
      [0, 2],
      [2, 2],
    ],
  },
  { extents: [[4, 0]] },
  { method: 0, extents: [[0, 4]] },
])("accepts definite in-range extent declarations %j", (options) => {
  expect(admit(layout(options))).toBe("withinBudget");
});

it.each([
  { extents: [[0, 5]] },
  { extents: [[5, 0]] },
  { base: 3, extents: [[1, 1]] },
  {
    extents: [
      [0, 2],
      [3, 2],
    ],
  },
  { extents: [[0, 1]], idat: false },
])(
  "rejects definite idat boundaries independently of image type %j",
  (options) => {
    expect(admit(layout(options))).toBe("invalid");
  },
);

it.each([
  { reference: 1, extents: [[9999, 9999]] },
  { method: 2, extents: [[9999, 9999]] },
  { version: 3, extents: [[9999, 9999]] },
])(
  "keeps unknown/external addressing outside local range claims %j",
  (options) => {
    expect(admit(layout(options))).toBe("notCovered");
  },
);

it.each(["image/avif", "image/jpeg", "image/png"])(
  "rejects recognized malformed AVIF before a media source under %s",
  (mimeType) => {
    const attachment = {
      kind: "image" as const,
      name: "controlled extent declaration",
      mimeType,
      data: changedStatic(124, 24),
    };
    const before = JSON.stringify(attachment);
    expect(attachmentMediaAdmission(attachment)).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    expect(JSON.stringify(attachment)).toBe(before);
  },
);
