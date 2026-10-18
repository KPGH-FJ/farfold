import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { messageAvifAdmission } from "./message_avif_admission";
import { attachmentMediaAdmission } from "./message_attachments";
import { MESSAGE_AVIF_PROGRESSIVE_TEST_DATA as PROGRESSIVE } from "./message_avif_layers_fixtures.test-support";
import { MAX_MESSAGE_RASTER_RECORDS } from "./message_raster_reader";
import {
  avifBox as box,
  avifIspe as ispe,
  u32,
} from "./message_avif_builders.test-support";

interface Box {
  at: number;
  size: number;
  kind: string;
}
function boxes(bytes: Buffer, start: number, end: number): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end;) {
    const size = bytes.readUInt32BE(at) || end - at;
    result.push({ at, size, kind: bytes.toString("ascii", at + 4, at + 8) });
    at += size;
  }
  return result;
}
function propertyBoxes(bytes: Buffer) {
  const meta = boxes(bytes, 0, bytes.length).find(
    ({ kind }) => kind === "meta",
  )!;
  const iprp = boxes(bytes, meta.at + 12, meta.at + meta.size).find(
    ({ kind }) => kind === "iprp",
  )!;
  const children = boxes(bytes, iprp.at + 8, iprp.at + iprp.size);
  const ipco = children.find(({ kind }) => kind === "ipco")!;
  return { meta, iprp, ipco, children };
}
function withUnusedProperties(properties: Buffer[]) {
  const original = Buffer.from(PROGRESSIVE, "base64");
  const { meta, iprp, ipco } = propertyBoxes(original);
  const added = Buffer.concat(properties);
  const at = ipco.at + ipco.size;
  const changed = Buffer.concat([
    original.subarray(0, at),
    added,
    original.subarray(at),
  ]);
  for (const parent of [meta, iprp, ipco])
    changed.writeUInt32BE(parent.size + added.length, parent.at);
  // The complete official fixture uses idat-local extents. Appending unused
  // properties moves the box but preserves every original association, local
  // extent and AV1 payload byte. No image/header dimensions are enlarged.
  return changed;
}

const fixtures = {
  "official-controls/draw_points_idat_progressive.avif": Buffer.from(
    PROGRESSIVE,
    "base64",
  ),
  "unused-small-positive.avif": withUnusedProperties([ispe(1, 1)]),
  "unused-edge-over-budget.avif": withUnusedProperties([ispe(8193, 1)]),
  "unused-pixels-over-budget.avif": withUnusedProperties([ispe(8192, 2049)]),
};

// These original four cases retain their failing diagnostic's literal
// expectations. All native-decode to the same complete 33x11 PNG; this proves
// this small complete image, not arbitrary AVIF variants or decoder budgets.
it.each(Object.keys(fixtures) as (keyof typeof fixtures)[])(
  "does not reject the actual 33x11 image for an unused property: %s",
  (name) => {
    const data = fixtures[name].toString("base64");
    const avif = messageAvifAdmission(data, true);
    const admission = attachmentMediaAdmission({
      kind: "image",
      name,
      mimeType: "image/avif",
      data,
    });
    expect.soft(avif).toBe("withinBudget");
    expect(admission.status).toBe("available");
  },
);

it("recreates the exact complete inputs retained with the original native decode evidence", () => {
  const expected = [
    "077ab2ad1e46dd912a973e4f024cb1eb242a08298be2dbf1a52a058e88c48a4a",
    "10ed4b77820c4893f3b62ba1bc5e08825f676e0bf67b4022b0e9f2351e357c12",
    "77c85557a35daa6e04cf3d199185fa6df2faac7f77d2b83aa74f52c3f1367500",
    "8b792544f4b931e711a4735a8358321628b92f1f1fbf11b2a83e7a79b6097307",
  ];
  expect(
    Object.values(fixtures).map((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    ),
  ).toEqual(expected);
});

it.each([
  ispe(0, 1),
  ispe(1, 0),
  box("ispe", Buffer.alloc(8)),
  box("ispe", Buffer.alloc(4), u32(1), u32(1), Buffer.from([0])),
])("still rejects explicitly invalid unused ispe structure", (property) => {
  expect(
    messageAvifAdmission(
      withUnusedProperties([property]).toString("base64"),
      true,
    ),
  ).toBe("invalid");
});

it("keeps known canvas checks when an unknown association layout cannot establish that a property is unused", () => {
  const changed = Buffer.from(fixtures["unused-edge-over-budget.avif"]);
  const association = propertyBoxes(changed).children.find(
    ({ kind }) => kind === "ipma",
  )!;
  changed[association.at + 8] = 7;
  expect(messageAvifAdmission(changed.toString("base64"), true)).toBe(
    "tooManyPixels",
  );
});

it("retains the common record budget for unused properties", () => {
  const changed = withUnusedProperties(
    Array.from({ length: MAX_MESSAGE_RASTER_RECORDS }, () => ispe(1, 1)),
  );
  expect(messageAvifAdmission(changed.toString("base64"), true)).toBe(
    "tooComplex",
  );
});
