import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { fixtureInput, pptxFixture, replacePptxPart } from "./pptx_fixture";
import { parsePptx } from "./pptx_parse";
import { checkedPptxDocument } from "./pptx_validation";
import { PptxError, type PptxWorkerInput } from "./pptx_types";
import { A, parseXml } from "./pptx_xml";
import { readColor } from "./pptx_theme";

const writerInput = (name: string) =>
  fixtureInput(
    readFileSync(new URL(`./fixtures/pptx/${name}`, import.meta.url)),
  );
const titleInput = () => writerInput("default-title-content.pptx");
const blankInput = () => writerInput("default-blank-basic.pptx");
const refuse = (input: PptxWorkerInput, code = "unsupported") => {
  expect(() => parsePptx(input)).toThrow(PptxError);
  try {
    parsePptx(input);
  } catch (error) {
    expect((error as PptxError).code).toBe(code);
  }
};

it.each([
  [
    "default-title-content.pptx",
    "7746ae1aceb54fd7ffb08a9599931e96cbf307cfc9bf9d9c99f02489b2216d90",
    [
      "PYTHON_PPTX_DEFAULT_TITLE",
      "Synthetic body line one",
      "Synthetic body line two",
    ],
    0,
  ],
  [
    "default-blank-basic.pptx",
    "002429cab2800a4736a61552f9e56b7851b314d5febcdca8217a61b7ebbd064e",
    ["PYTHON_PPTX_PLAIN_TEXTBOX", "Synthetic rectangle"],
    1,
  ],
])(
  "previews unchanged ordinary writer export %s",
  (name, sha, text, images) => {
    const raw = readFileSync(
      new URL(`./fixtures/pptx/${name}`, import.meta.url),
    );
    expect(createHash("sha256").update(raw).digest("hex")).toBe(sha);
    const input = fixtureInput(raw);
    const document = parsePptx(input);
    checkedPptxDocument(document, new Set(input.parts.map((p) => p.name)));
    expect([document.width, document.height]).toEqual([960, 720]);
    expect(document.slides).toHaveLength(1);
    expect(document.partial).toBe(true);
    expect(
      document.warnings.some(
        (warning) => warning.code === "unsupportedFormatting",
      ),
    ).toBe(true);
    const actualText = document.slides.flatMap((slide) =>
      slide.shapes.flatMap((shape) =>
        shape.kind === "shape"
          ? (shape.text?.paragraphs.flatMap((paragraph) =>
              paragraph.runs.flatMap((run) =>
                run.kind === "text" ? [run.text] : [],
              ),
            ) ?? [])
          : [],
      ),
    );
    for (const expected of text) expect(actualText).toContain(expected);
    expect(document.images).toHaveLength(images);
  },
);

it("retains ordinary placeholder geometry, literal bullets and source text without template prompt text", () => {
  const document = parsePptx(titleInput()),
    [title, body] = document.slides[0].shapes;
  expect(document.slides[0].shapes.map((shape) => shape.source)).toEqual([
    { part: "ppt/slides/slide1.xml", shapeId: "2", layer: "slide" },
    { part: "ppt/slides/slide1.xml", shapeId: "3", layer: "slide" },
  ]);
  expect(title.box).toEqual({
    x: 48,
    y: 274638 / 9525,
    width: 864,
    height: 120,
  });
  expect(body.box).toEqual({
    x: 48,
    y: 168,
    width: 864,
    height: 4525963 / 9525,
  });
  if (body.kind !== "shape") throw Error("expected source text shape");
  expect(
    body.text?.paragraphs.map((paragraph) =>
      paragraph.runs
        .filter((run) => run.kind === "text")
        .map((run) => run.text),
    ),
  ).toEqual([
    ["• ", "Synthetic body line one"],
    ["• ", "Synthetic body line two"],
  ]);
});

it("retains direct rectangle paint and authored bitmap bytes on the unmodified default template", () => {
  const document = parsePptx(blankInput());
  expect(document.slides[0].shapes.map((shape) => shape.box)).toEqual([
    { x: 96, y: 48, width: 576, height: 96 },
    { x: 96, y: 192, width: 192, height: 96 },
    { x: 480, y: 192, width: 96, height: 96 },
  ]);
  expect(document.slides[0].shapes[1]).toMatchObject({
    kind: "shape",
    geometry: "rect",
    fill: "#1F7A5C",
  });
  expect(
    createHash("sha256").update(document.images[0].bytes).digest("hex"),
  ).toBe("35be740d3586bac1c7ce58e9e4860485a8d966f8af809c47d05ec3faf976be41");
});

it.each([
  [
    "unknown creation extension",
    (xml: string) =>
      xml.replace("{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}", "{UNKNOWN}"),
  ],
  [
    "unknown extension payload",
    (xml: string) => xml.replace("p14:creationId", "p14:unknownPaint"),
  ],
  [
    "creation identifier overflow",
    (xml: string) => xml.replace('val="2614314258"', 'val="4294967296"'),
  ],
  [
    "creation identifier unknown attribute",
    (xml: string) =>
      xml.replace('val="2614314258"', 'val="2614314258" paint="red"'),
  ],
  [
    "visible extension child",
    (xml: string) =>
      xml.replace(
        'val="2614314258"/>',
        'val="2614314258"><a:solidFill/></p14:creationId>',
      ),
  ],
])("still refuses %s", (_name, change) => {
  refuse(
    replacePptxPart(titleInput(), "ppt/slideLayouts/slideLayout2.xml", change),
  );
});

it("does not apply new-object insertion defaults to shapes already in the file", () => {
  const input = titleInput();
  const changed = replacePptxPart(input, "ppt/theme/theme1.xml", (xml) =>
    xml.replace(
      /<a:objectDefaults>.*?<\/a:objectDefaults>/,
      '<a:objectDefaults><a:spDef><a:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:spPr></a:spDef></a:objectDefaults>',
    ),
  );
  expect(changed).not.toEqual(input);
  expect(parsePptx(changed)).toEqual(parsePptx(input));
});

it("does not make unknown ordinary geometry transparent to get a successful parse", () => {
  refuse(
    replacePptxPart(pptxFixture(), "ppt/slides/slide2.xml", (xml) =>
      xml.replace(
        '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln>',
        "",
      ),
    ),
  );
});

it("does not turn explicit unsupported textbox paint into a transparent default", () => {
  refuse(
    replacePptxPart(blankInput(), "ppt/slides/slide1.xml", (xml) =>
      xml.replace("<a:noFill/>", "<a:gradFill/>"),
    ),
  );
});

it("honors a direct no-bullet override rather than keeping the inherited bullet", () => {
  const document = parsePptx(
    replacePptxPart(titleInput(), "ppt/slides/slide1.xml", (xml) =>
      xml.replace(
        "<a:p><a:r><a:t>Synthetic body line one",
        "<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Synthetic body line one",
      ),
    ),
  );
  const body = document.slides[0].shapes[1];
  if (body.kind !== "shape") throw Error("expected source text shape");
  expect(body.text?.paragraphs[0].runs).toHaveLength(1);
  expect(body.text?.paragraphs[1].runs[0]).toMatchObject({ text: "• " });
});

it.each([
  [
    "unknown shadow effect",
    (xml: string) => xml.replaceAll("outerShdw", "unknownEffect"),
  ],
  [
    "unknown shadow paint",
    (xml: string) =>
      xml.replace(
        '<a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr>',
        "<a:gradFill/>",
      ),
  ],
  [
    "unknown shadow opacity attribute",
    (xml: string) =>
      xml.replace(
        '<a:alpha val="35000"/>',
        '<a:alpha val="35000" paint="red"/>',
      ),
  ],
  [
    "nonempty shadow opacity text",
    (xml: string) =>
      xml.replace(
        '<a:alpha val="35000"/>',
        '<a:alpha val="35000">paint</a:alpha>',
      ),
  ],
  [
    "nonempty shadow text",
    (xml: string) => xml.replaceAll("</a:outerShdw>", "paint</a:outerShdw>"),
  ],
  [
    "unknown effect-list attribute",
    (xml: string) =>
      xml.replaceAll("<a:effectLst>", '<a:effectLst paint="red">'),
  ],
  [
    "nonempty effect-list text",
    (xml: string) => xml.replaceAll("<a:effectLst>", "<a:effectLst>paint"),
  ],
  [
    "unknown shadow colour attribute",
    (xml: string) =>
      xml.replaceAll(
        '<a:srgbClr val="000000">',
        '<a:srgbClr val="000000" paint="red">',
      ),
  ],
])("still rejects %s in an ordinary theme", (_name, change) => {
  refuse(replacePptxPart(blankInput(), "ppt/theme/theme1.xml", change));
});

const color = (effects: string, value = "FF0000") =>
  readColor(
    parseXml(
      new TextEncoder().encode(
        `<a:solidFill xmlns:a="${A}"><a:srgbClr val="${value}">${effects}</a:srgbClr></a:solidFill>`,
      ),
      { nodes: 0, text: 0 },
    ),
    { colors: new Map(), fonts: new Map() },
    {},
  );
it("applies primary-specified shade and HSL saturation modulation instead of guessing an outline colour", () => {
  expect(color('<a:shade val="50000"/>', "FFFFFF")).toBe("#808080");
  expect(color('<a:satMod val="50000"/>')).toBe("#BF4040");
  expect(color('<a:shade val="50000"/><a:satMod val="0"/>')).toBe("#404040");
  expect(color('<a:satMod val="1000001"/>')).toBe("#FF0000");
  expect(color('<a:satMod val="2147483647"/>')).toBe("#FF0000");
  expect(color('<a:satMod val="-2147483648"/>')).toBe("#808080");
});

it("preserves a newly supported literal bullet instead of hiding it in a successful plain paragraph", () => {
  const document = parsePptx(
    replacePptxPart(pptxFixture(), "ppt/slides/slide2.xml", (xml) =>
      xml.replace(
        '<a:pPr algn="l"/>',
        '<a:pPr algn="l"><a:buChar char="●"/></a:pPr>',
      ),
    ),
  );
  const title = document.slides[0].shapes.find(
    (shape) => shape.source.layer === "slide" && shape.source.shapeId === "2",
  );
  if (title?.kind !== "shape") throw Error("expected source text shape");
  expect(title.text?.paragraphs[0].runs[0]).toMatchObject({
    kind: "text",
    text: "● ",
  });
  expect(document.partial).toBe(true);
});

it.each([
  [
    "unknown bullet font subtree",
    (xml: string) =>
      xml.replace(
        '<a:buFont typeface="Arial"/>',
        '<a:buFont typeface="Arial"><a:unknownPaint/></a:buFont>',
      ),
  ],
  [
    "unknown bullet attribute",
    (xml: string) =>
      xml.replace('<a:buChar char="•"/>', '<a:buChar char="•" paint="red"/>'),
  ],
])("does not silently accept %s", (_name, change) => {
  refuse(
    replacePptxPart(titleInput(), "ppt/slideMasters/slideMaster1.xml", change),
  );
});

it("rejects unknown automatic shape-resize settings", () => {
  refuse(
    replacePptxPart(blankInput(), "ppt/slides/slide1.xml", (xml) =>
      xml.replace("<a:spAutoFit/>", '<a:spAutoFit unknown="1"/>'),
    ),
  );
});

it("retains the shadow bounds limit instead of turning an excessive effect into partial success", () => {
  refuse(
    replacePptxPart(blankInput(), "ppt/theme/theme1.xml", (xml) =>
      xml.replaceAll('blurRad="40000"', 'blurRad="9525000001"'),
    ),
    "limit",
  );
});

it("does not broaden opacity or unknown colour transforms", () => {
  expect(() => color('<a:alpha val="50000"/>')).toThrow(PptxError);
  expect(() => color('<a:lumMod val="50000"/>')).toThrow(PptxError);
  expect(() => color('<a:satMod val="2147483648"/>')).toThrow(PptxError);
  expect(() => color('<a:satMod val="-2147483649"/>')).toThrow(PptxError);
  expect(() => color('<a:satMod val="1.5"/>')).toThrow(PptxError);
  expect(() => color('<a:shade val="50000">paint</a:shade>')).toThrow(
    PptxError,
  );
});
