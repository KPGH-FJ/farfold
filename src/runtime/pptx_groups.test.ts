import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { fixtureInput, replacePptxPart } from "./pptx_fixture";
import { parsePptx } from "./pptx_parse";
import { checkedPptxDocument } from "./pptx_validation";
import { PptxError, type PptxWorkerInput } from "./pptx_types";

const part = "ppt/slides/slide1.xml";
const input = () =>
  fixtureInput(
    readFileSync(
      new URL("./fixtures/pptx/ordinary-group.pptx", import.meta.url),
    ),
  );
const check = (capture: PptxWorkerInput) =>
  checkedPptxDocument(
    parsePptx(capture),
    new Set(capture.parts.map((p) => p.name)),
  );
const transform = (value: PptxWorkerInput, change: (xml: string) => string) =>
  replacePptxPart(value, part, change);
const reject = (capture: PptxWorkerInput, code = "unsupported") => {
  try {
    check(capture);
    throw Error("Unexpected successful preview");
  } catch (error) {
    expect(error).toBeInstanceOf(PptxError);
    expect((error as PptxError).code).toBe(code);
  }
};

it("previews an unchanged author-created group without losing its text, paint, source or order", () => {
  const doc = check(input()),
    shapes = doc.slides[0].shapes;
  expect(shapes.map((s) => s.source.shapeId)).toEqual(["3", "4"]);
  expect(shapes[0]).toMatchObject({
    kind: "shape",
    fill: "#1F7A5C",
    box: { x: 96, y: 96, width: 192, height: 96 },
    groupTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
  });
  expect(shapes[1]).toMatchObject({
    box: { x: 96, y: 240, width: 384, height: 96 },
    text: {
      paragraphs: [{ runs: [{ text: "GROUPED PREVIEW", fontSize: 32 }] }],
    },
  });
});
it("composes a nonuniform group scale and translation without rewriting local text geometry", () => {
  const doc = check(
    transform(input(), (xml) =>
      xml.replace(
        '<a:off x="914400" y="914400"/><a:ext cx="3657600" cy="2286000"/>',
        '<a:off x="1828800" y="457200"/><a:ext cx="5486400" cy="4572000"/>',
      ),
    ),
  );
  expect(doc.slides[0].shapes[0]).toMatchObject({
    box: { x: 96, y: 96, width: 192, height: 96 },
    groupTransform: { x: 48, y: -144, scaleX: 1.5, scaleY: 2 },
  });
});
it("rejects a group with unknown geometry instead of dropping only that content", () => {
  reject(
    transform(input(), (xml) => xml.replace('prst="rect"', 'prst="triangle"')),
  );
});
it.each([
  [
    "rotation",
    (xml: string) =>
      xml.replace("<p:grpSpPr><a:xfrm>", '<p:grpSpPr><a:xfrm rot="60000">'),
  ],
  [
    "flip",
    (xml: string) =>
      xml.replace("<p:grpSpPr><a:xfrm>", '<p:grpSpPr><a:xfrm flipH="1">'),
  ],
  [
    "effect",
    (xml: string) =>
      xml.replace(
        "</p:grpSpPr><p:sp>",
        '<a:effectLst><a:glow rad="100"/></a:effectLst></p:grpSpPr><p:sp>',
      ),
  ],
] as const)("rejects unsupported group %s", (_name, change) =>
  reject(transform(input(), change)),
);
it("rejects duplicate shape identities inside the group", () => {
  reject(
    transform(input(), (xml) =>
      xml.replace('id="4" name="TextBox 3"', 'id="3" name="TextBox 3"'),
    ),
    "invalid",
  );
});
it("rejects zero child-coordinate extent", () => {
  reject(
    transform(input(), (xml) =>
      xml.replace('<a:chExt cx="3657600"', '<a:chExt cx="0"'),
    ),
    "invalid",
  );
});

it("composes nested groups and preserves the complete child order", () => {
  const nested = transform(input(), (xml) =>
    xml
      .replace(
        "<p:grpSp><p:nvGrpSpPr>",
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="Outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="952500" y="476250"/><a:ext cx="7315200" cy="4572000"/><a:chOff x="0" y="0"/><a:chExt cx="3657600" cy="2286000"/></a:xfrm></p:grpSpPr><p:grpSp><p:nvGrpSpPr>',
      )
      .replace("</p:grpSp></p:spTree>", "</p:grpSp></p:grpSp></p:spTree>"),
  );
  const shapes = check(nested).slides[0].shapes;
  expect(shapes.map((s) => s.source.shapeId)).toEqual(["3", "4"]);
  expect(shapes.map((s) => s.groupTransform)).toEqual([
    { x: 100, y: 50, scaleX: 2, scaleY: 2 },
    { x: 100, y: 50, scaleX: 2, scaleY: 2 },
  ]);
});
it("omits a hidden group as a whole with an explicit partial warning", () => {
  const doc = check(
    transform(input(), (xml) =>
      xml.replace('id="2" name="Group 1"', 'id="2" name="Group 1" hidden="1"'),
    ),
  );
  expect(doc.slides[0].shapes).toEqual([]);
  expect(doc.partial).toBe(true);
  expect(doc.warnings).toContainEqual({
    code: "hiddenContent",
    slideId: "256",
    count: 1,
  });
});
it("keeps duplicate IDs across group and outer shapes invalid", () => {
  reject(
    transform(input(), (xml) =>
      xml.replace('id="4" name="TextBox 3"', 'id="2" name="TextBox 3"'),
    ),
    "invalid",
  );
});
it.each([
  [
    "unknown attribute",
    (xml: string) => xml.replace("<p:grpSp>", '<p:grpSp active="1">'),
  ],
  [
    "unknown child",
    (xml: string) => xml.replace("</p:grpSp>", "<p:extLst/></p:grpSp>"),
  ],
  [
    "unknown transform attribute",
    (xml: string) =>
      xml.replace("<p:grpSpPr><a:xfrm>", '<p:grpSpPr><a:xfrm skew="10">'),
  ],
] as const)("does not ignore %s in a visible group", (_name, change) =>
  reject(transform(input(), change)),
);
it("rejects an excessive composed scale before it reaches display", () => {
  reject(
    transform(input(), (xml) =>
      xml.replace(
        '<a:chExt cx="3657600" cy="2286000"/>',
        '<a:chExt cx="1" cy="1"/>',
      ),
    ),
    "limit",
  );
});
it.each([
  [
    "unknown field",
    { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 30 },
    "invalid",
  ],
  ["negative scale", { x: 0, y: 0, scaleX: -1, scaleY: 1 }, "limit"],
  ["zero scale", { x: 0, y: 0, scaleX: 0, scaleY: 1 }, "limit"],
  [
    "unbounded translation",
    { x: Infinity, y: 0, scaleX: 1, scaleY: 1 },
    "invalid",
  ],
  [
    "oversized projected geometry",
    { x: 0, y: 0, scaleX: 10000, scaleY: 1 },
    "limit",
  ],
  ["missing component", { x: 0, y: 0, scaleX: 1 }, "invalid"],
] as const)(
  "rejects worker group transform with %s",
  (_name, groupTransform, code) => {
    const capture = input(),
      doc = parsePptx(capture);
    Object.assign(doc.slides[0].shapes[0], { groupTransform });
    expect(() =>
      checkedPptxDocument(doc, new Set(capture.parts.map((p) => p.name))),
    ).toThrow(PptxError);
    try {
      checkedPptxDocument(doc, new Set(capture.parts.map((p) => p.name)));
    } catch (e) {
      expect((e as PptxError).code).toBe(code);
    }
  },
);
