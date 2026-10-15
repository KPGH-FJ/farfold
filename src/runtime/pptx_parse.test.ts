import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePptx } from "./pptx_parse";
import { pptxFixture, replacePptxPart } from "./pptx_fixture";
import { checkedPptxDocument } from "./pptx_validation";
import { PptxError, type PptxShape, type PptxWorkerInput } from "./pptx_types";

const SLIDE = "ppt/slides/slide2.xml",
  LAYOUT = "ppt/slideLayouts/slideLayout1.xml",
  MASTER = "ppt/slideMasters/slideMaster1.xml",
  THEME = "ppt/theme/theme1.xml";
const parse = () => parsePptx(pptxFixture());
const find = (shapes: PptxShape[], id: string) =>
  shapes.find((s) => s.source.layer === "slide" && s.source.shapeId === id)!;
const texts = (s: PptxShape) =>
  s.kind === "shape"
    ? s.text?.paragraphs.flatMap((p) => p.runs).filter((r) => r.kind === "text")
    : undefined;
const edit = (part: string, f: (s: string) => string) =>
  replacePptxPart(pptxFixture(), part, f);
const reject = (input: PptxWorkerInput, code = "unsupported") => {
  expect(() => parsePptx(input)).toThrow(PptxError);
  try {
    parsePptx(input);
  } catch (e) {
    expect((e as PptxError).code).toBe(code);
  }
};

describe("PPTX authored geometry, theme, source and bitmap model", () => {
  it("retains the independent author fixture and oracle bytes", () => {
    const digest = (name: string) =>
      createHash("sha256")
        .update(
          readFileSync(new URL(`./fixtures/pptx/${name}`, import.meta.url)),
        )
        .digest("hex");
    expect(digest("author-two-slide-layout-theme.pptx")).toBe(
      "2926fecb62ab09afb99369d8fddcecb4bb6a0dd46f80e774920ebb619c945acc",
    );
    expect(digest("author-oracle.json.raw")).toBe(
      "e01347ab74fc27dc04bd1b963864f4820654735d5c00d05aa09f584a6514a3a9",
    );
  });
  it("uses presentation order and explicit CSS px units", () => {
    const d = parse();
    expect([d.width, d.height]).toEqual([960, 540]);
    expect(d.slides.map((s) => [s.id, s.part, s.background])).toEqual([
      ["512", SLIDE, "#FFFFFF"],
      ["256", "ppt/slides/slide1.xml", "#FFFFFF"],
    ]);
    expect(
      d.slides.map((s) =>
        s.shapes.map((x) => [x.source.layer, x.source.shapeId]),
      ),
    ).toEqual([
      [
        ["master", "9"],
        ["slide", "2"],
        ["slide", "11"],
        ["slide", "14"],
        ["slide", "21"],
        ["slide", "31"],
      ],
      [
        ["master", "9"],
        ["slide", "2"],
        ["slide", "12"],
        ["slide", "32"],
      ],
    ]);
  });
  it("resolves layout position, theme title, direct overrides and no duplicate inherited placeholder", () => {
    const d = parse(),
      first = find(d.slides[0].shapes, "2"),
      second = find(d.slides[1].shapes, "2");
    expect(first.box).toEqual({ x: 96, y: 48, width: 768, height: 96 });
    expect(texts(first)).toEqual([
      {
        kind: "text",
        text: "LAYOUT THEME 01",
        fontFamily: "Arial",
        fontSize: 3200 / 75,
        color: "#1F7A5C",
        bold: false,
        italic: false,
        underline: false,
      },
    ]);
    expect(second.box).toEqual({ x: 48, y: 24, width: 864, height: 96 });
    expect(texts(second)?.[0]).toMatchObject({
      text: "DIRECT OVERRIDE 02",
      color: "#C62828",
    });
    expect(
      d.slides.map(
        (s) => s.shapes.filter((x) => x.kind === "shape" && x.text).length,
      ),
    ).toEqual([2, 2]);
  });
  it("retains authored rect, ellipse, footer and bitmap rather than flattening to page text", () => {
    const d = parse(),
      s = d.slides[0];
    expect(s.shapes[0]).toMatchObject({
      kind: "shape",
      geometry: "rect",
      fill: "#E5A329",
      box: { x: 0, y: 468, width: 960, height: 24 },
      source: { part: MASTER, shapeId: "9", layer: "master" },
    });
    expect(find(s.shapes, "11")).toMatchObject({
      kind: "shape",
      geometry: "rect",
      fill: "#1F7A5C",
      box: { x: 96, y: 192, width: 192, height: 96 },
    });
    expect(find(s.shapes, "14")).toMatchObject({
      kind: "shape",
      geometry: "ellipse",
      fill: "#3264C8",
      box: { x: 384, y: 192, width: 144, height: 96 },
    });
    expect(find(s.shapes, "21")).toMatchObject({
      kind: "image",
      imageId: "ppt/media/quadrants.png",
      box: { x: 672, y: 192, width: 192, height: 192 },
    });
    expect(texts(find(s.shapes, "31"))?.[0]).toMatchObject({
      text: "BODY A - 甲",
      fontSize: 32,
      color: "#17212B",
    });
    expect(d.images).toHaveLength(1);
    expect(d.images[0]).toMatchObject({
      id: "ppt/media/quadrants.png",
      mimeType: "image/png",
      width: 16,
      height: 16,
    });
    expect(d.slides[1].shapes.filter((s) => s.kind === "image")).toEqual([]);
  });
  it("remains independent of ZIP/parts order and passes the separate closed-model gate", () => {
    const f = pptxFixture();
    const d = parsePptx({
      ...f,
      entries: [...f.entries].reverse(),
      parts: [...f.parts].reverse(),
    });
    expect(d).toEqual(parse());
    expect(checkedPptxDocument(d, new Set(f.parts.map((p) => p.name)))).toBe(d);
    expect(d.partial).toBe(false);
    expect(d.warnings.map((w) => w.code)).toEqual([
      "fontSubstitution",
      "fontSubstitution",
    ]);
  });
  it("matches slide-layout by idx even when placeholder types differ", () => {
    const d = parsePptx(
      edit(LAYOUT, (s) =>
        s.replace('type="title" idx="7"', 'type="body" idx="7"'),
      ),
    );
    expect(find(d.slides[0].shapes, "2").box).toEqual({
      x: 96,
      y: 48,
      width: 768,
      height: 96,
    });
  });
  it("matches layout-master by type, not differing master idx or shape id", () => {
    let input = edit(MASTER, (s) =>
      s.replace('type="title" idx="7"', 'type="title" idx="99"'),
    );
    input = replacePptxPart(input, LAYOUT, (s) =>
      s.replace(/<a:xfrm>.*?<\/a:xfrm>/g, (m, at) =>
        at > s.indexOf('name="Layout position') ? "" : m,
      ),
    );
    expect(find(parsePptx(input).slides[0].shapes, "2").box).toEqual({
      x: 24,
      y: 24,
      width: 480,
      height: 72,
    });
  });
  it("does not fabricate a direct master match when slide-layout idx is absent", () => {
    reject(
      edit(LAYOUT, (s) =>
        s.replace('type="title" idx="7"', 'type="title" idx="99"'),
      ),
    );
  });
  it("allows negative slide-clipped positions without changing authored size", () => {
    const d = parsePptx(
      edit(SLIDE, (s) =>
        s.replace('x="914400" y="1828800"', 'x="-914400" y="1828800"'),
      ),
    );
    expect(find(d.slides[0].shapes, "11").box).toEqual({
      x: -96,
      y: 192,
      width: 192,
      height: 96,
    });
  });
  it("honors hidden shapes and hidden slides with explicit partial warning", () => {
    const d = parsePptx(
      edit(SLIDE, (s) =>
        s.replace('id="14" name=', 'id="14" hidden="1" name='),
      ),
    );
    expect(d.partial).toBe(true);
    expect(d.slides[0].shapes.some((s) => s.source.shapeId === "14")).toBe(
      false,
    );
    expect(d.warnings).toContainEqual({
      code: "hiddenContent",
      count: 1,
      slideId: "512",
    });
    const f = pptxFixture(),
      h = parsePptx(
        replacePptxPart(f, SLIDE, (s) =>
          s.replace('showMasterSp="1"', 'showMasterSp="1" show="0"'),
        ),
      );
    expect(h.slides.map((s) => s.id)).toEqual(["256"]);
    expect(h.warnings).toContainEqual({ code: "hiddenContent", count: 1 });
    expect(checkedPptxDocument(h, new Set(f.parts.map((p) => p.name)))).toBe(h);
  });
  it("resolves theme fonts and style matrix fills/lines", () => {
    let f = edit(SLIDE, (s) =>
      s.replace('<a:latin typeface="Arial"/>', '<a:latin typeface="+mj-lt"/>'),
    );
    f = replacePptxPart(f, SLIDE, (s) =>
      s.replace('<a:schemeClr val="accent1"/>', '<a:schemeClr val="accent2"/>'),
    );
    expect(texts(find(parsePptx(f).slides[0].shapes, "2"))?.[0]).toMatchObject({
      fontFamily: "Arial",
      color: "#E5A329",
    });
    f = edit(SLIDE, (s) =>
      s.replace(
        '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>',
        '</p:spPr><p:style><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef><a:lnRef idx="1"><a:srgbClr val="123456"/></a:lnRef><a:effectRef idx="1"><a:schemeClr val="accent1"/></a:effectRef></p:style></p:sp>',
      ),
    );
    expect(find(parsePptx(f).slides[0].shapes, "11")).toMatchObject({
      fill: "#E5A329",
      stroke: { color: "#123456", width: 12700 / 9525 },
    });
  });
});

describe("PPTX text and passive shape metadata", () => {
  it("an explicit slide masterClrMapping restores the master instead of inheriting a layout override", () => {
    const f = edit(LAYOUT, (s) =>
      s.replace(
        "<a:masterClrMapping/>",
        '<a:overrideClrMapping accent1="accent2"/>',
      ),
    );
    expect(texts(find(parsePptx(f).slides[0].shapes, "2"))?.[0]).toMatchObject({
      color: "#1F7A5C",
    });
    const inherited = replacePptxPart(f, SLIDE, (s) =>
      s.replace("<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>", ""),
    );
    expect(
      texts(find(parsePptx(inherited).slides[0].shapes, "2"))?.[0],
    ).toMatchObject({ color: "#E5A329" });
  });
  it.each([
    ["ctrTitle", "title"],
    ["subTitle", "body"],
    ["obj", "body"],
    ["pic", "body"],
    ["chart", "body"],
    ["clipArt", "body"],
    ["dgm", "body"],
    ["media", "body"],
    ["tbl", "body"],
    ["body", "body"],
    ["dt", "dt"],
    ["ftr", "ftr"],
    ["sldNum", "sldNum"],
  ])(
    "maps layout %s to master %s independently of idx and inherits geometry/font",
    (type, base) => {
      let f = edit(MASTER, (s) =>
        s
          .replace('type="title" idx="7"', `type="${base}" idx="99"`)
          .replace(
            `<p:${base === "title" ? "title" : base === "body" ? "body" : "other"}Style/>`,
            `<p:${base === "title" ? "title" : base === "body" ? "body" : "other"}Style><a:lvl1pPr><a:defRPr sz="2800"><a:solidFill><a:srgbClr val="334455"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:${base === "title" ? "title" : base === "body" ? "body" : "other"}Style>`,
          ),
      );
      f = replacePptxPart(f, LAYOUT, (s) =>
        s
          .replace('type="title" idx="7"', `type="${type}" idx="7"`)
          .replace(/<a:xfrm>.*?<\/a:xfrm>/g, (m, at) =>
            at > s.indexOf('name="Layout position') ? "" : m,
          ),
      );
      f = replacePptxPart(f, SLIDE, (s) =>
        s
          .replace('type="title" idx="7"', `type="${type}" idx="7"`)
          .replace(/<a:rPr.*?<\/a:rPr>/, "<a:rPr/>"),
      );
      const title = find(parsePptx(f).slides[0].shapes, "2");
      expect(title.box).toEqual({ x: 24, y: 24, width: 480, height: 72 });
      expect(texts(title)?.[0]).toMatchObject({
        fontFamily: "Arial",
        fontSize: 2800 / 75,
        color: "#334455",
      });
    },
  );
  it("treats an omitted layout placeholder type as obj mapped to master body", () => {
    let f = edit(MASTER, (s) =>
      s.replace('type="title" idx="7"', 'type="body" idx="99"'),
    );
    f = replacePptxPart(f, LAYOUT, (s) =>
      s
        .replace('type="title" idx="7"', 'idx="7"')
        .replace(/<a:xfrm>.*?<\/a:xfrm>/g, (m, at) =>
          at > s.indexOf('name="Layout position') ? "" : m,
        ),
    );
    expect(find(parsePptx(f).slides[0].shapes, "2").box).toEqual({
      x: 24,
      y: 24,
      width: 480,
      height: 72,
    });
  });
  it.each(["hdr", "sldImg", "unknownRole"])(
    "rejects unknown/notes-only required layout role %s",
    (type) => {
      reject(
        edit(LAYOUT, (s) =>
          s.replace('type="title" idx="7"', `type="${type}" idx="7"`),
        ),
      );
    },
  );
  it("inherits real master text defaults and preserves direct false overrides", () => {
    let f = edit(MASTER, (s) =>
      s.replace(
        "<p:titleStyle/>",
        '<p:titleStyle><a:lvl1pPr><a:defRPr sz="2800" b="1" i="1"><a:solidFill><a:srgbClr val="334455"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>',
      ),
    );
    f = replacePptxPart(f, SLIDE, (s) =>
      s.replace(/<a:rPr.*?<\/a:rPr>/, '<a:rPr b="0" i="0"/>'),
    );
    expect(texts(find(parsePptx(f).slides[0].shapes, "2"))?.[0]).toMatchObject({
      fontFamily: "Arial",
      fontSize: 2800 / 75,
      color: "#334455",
      bold: false,
      italic: false,
    });
  });
  it("honors colour-map overrides and leaves hyperlinks passive without copying URLs", () => {
    let f = edit(SLIDE, (s) =>
      s
        .replace(
          "<a:masterClrMapping/>",
          '<a:overrideClrMapping accent1="accent2"/>',
        )
        .replace(
          'name="Layout title with theme colour"/>',
          'name="Layout title with theme colour"><a:hlinkClick r:id="link"/></p:cNvPr>',
        ),
    );
    f = replacePptxPart(f, "ppt/slides/_rels/slide2.xml.rels", (s) =>
      s.replace(
        "</Relationships>",
        '<Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private-label" TargetMode="External"/></Relationships>',
      ),
    );
    const d = parsePptx(f);
    expect(texts(find(d.slides[0].shapes, "2"))?.[0]).toMatchObject({
      color: "#E5A329",
    });
    expect(d.warnings).toContainEqual({
      code: "hyperlinks",
      count: 1,
      slideId: "512",
    });
    expect(d.partial).toBe(false);
    expect(JSON.stringify(d)).not.toContain("example.invalid");
  });
});
describe("PPTX refuses unsupported visible operations and malformed packages", () => {
  it.each([
    [
      "ellipsis text overflow",
      SLIDE,
      (s: string) =>
        s.replace('anchor="t"/>', 'anchor="t" vertOverflow="ellipsis"/>'),
    ],
    [
      "clipped horizontal overflow",
      SLIDE,
      (s: string) =>
        s.replace('anchor="t"/>', 'anchor="t" horzOverflow="clip"/>'),
    ],
    [
      "unsupported stroke join",
      SLIDE,
      (s: string) =>
        s.replace(
          "<a:ln><a:noFill/></a:ln>",
          '<a:ln><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:round/></a:ln>',
        ),
    ],
    [
      "picture background",
      SLIDE,
      (s: string) =>
        s.replace(
          "<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic>",
          '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:pic>',
        ),
    ],
    [
      "picture video declaration",
      SLIDE,
      (s: string) =>
        s.replace(
          '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/>',
          '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rImage"/></p:nvPr>',
        ),
    ],
    [
      "unknown placeholder paragraph inheritance",
      LAYOUT,
      (s: string) =>
        s.replace(
          "<a:p><a:endParaRPr/>",
          '<a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr/>',
        ),
    ],
    [
      "rotation",
      SLIDE,
      (s: string) =>
        s.replace(
          '<a:xfrm><a:off x="914400"',
          '<a:xfrm rot="60000"><a:off x="914400"',
        ),
    ],
    [
      "flip",
      SLIDE,
      (s: string) =>
        s.replace(
          '<a:xfrm><a:off x="914400"',
          '<a:xfrm flipH="1"><a:off x="914400"',
        ),
    ],
    [
      "crop",
      SLIDE,
      (s: string) =>
        s.replace("<a:stretch>", '<a:srcRect l="1000"/><a:stretch>'),
    ],
    [
      "tile",
      SLIDE,
      (s: string) =>
        s.replace("<a:stretch><a:fillRect/></a:stretch>", "<a:tile/>"),
    ],
    [
      "unsupported geometry",
      SLIDE,
      (s: string) => s.replace('prst="ellipse"', 'prst="triangle"'),
    ],
    [
      "colour transforms",
      SLIDE,
      (s: string) =>
        s.replace(
          '<a:schemeClr val="accent1"/>',
          '<a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr>',
        ),
    ],
    [
      "shape effects",
      SLIDE,
      (s: string) =>
        s.replace(
          "</p:spPr></p:sp>",
          "<a:effectLst><a:outerShdw/></a:effectLst></p:spPr></p:sp>",
        ),
    ],
    [
      "gradient",
      SLIDE,
      (s: string) =>
        s.replace(
          '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln>',
          "<a:gradFill/><a:ln>",
        ),
    ],
    [
      "bullet",
      SLIDE,
      (s: string) =>
        s.replace(
          '<a:pPr algn="l"/>',
          '<a:pPr algn="l"><a:buChar char="●"/></a:pPr>',
        ),
    ],
    [
      "autofit",
      SLIDE,
      (s: string) =>
        s.replace('anchor="t"/>', 'anchor="t"><a:spAutofit/></a:bodyPr>'),
    ],
    [
      "vertical text",
      SLIDE,
      (s: string) => s.replace('anchor="t"/>', 'anchor="t" vert="vert"/>'),
    ],
    [
      "group",
      SLIDE,
      (s: string) =>
        s.replace(
          /<p:sp><p:nvSpPr><p:cNvPr id="11".*?<\/p:sp>/,
          '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="11"/></p:nvGrpSpPr><p:grpSpPr/></p:grpSp>',
        ),
    ],
    [
      "animation",
      SLIDE,
      (s: string) =>
        s.replace("</p:sld>", "<p:timing><p:tnLst/></p:timing></p:sld>"),
    ],
    [
      "doctype",
      SLIDE,
      (s: string) =>
        s.replace("<p:sld ", '<!DOCTYPE p:sld [<!ENTITY x "unsafe">]><p:sld '),
    ],
    [
      "theme font missing",
      SLIDE,
      (s: string) =>
        s.replace(
          '<a:latin typeface="Arial"/>',
          '<a:latin typeface="+mj-ea"/>',
        ),
    ],
    [
      "unknown namespace",
      SLIDE,
      (s: string) =>
        s.replace(
          "<a:t>LAYOUT THEME 01</a:t>",
          '<z:t xmlns:z="urn:unknown">LAYOUT THEME 01</z:t>',
        ),
    ],
  ] as const)("rejects %s", (_name, part, transform) =>
    reject(
      edit(part, transform),
      _name === "unknown namespace" ? "invalid" : "unsupported",
    ),
  );
  it("rejects external image resources and embedded active content", () => {
    reject(
      edit("ppt/slides/_rels/slide2.xml.rels", (s) =>
        s.replace(
          'Target="../media/quadrants.png"',
          'Target="https://example.invalid/a.png" TargetMode="External"',
        ),
      ),
    );
    reject({
      ...pptxFixture(),
      entries: [...pptxFixture().entries, "ppt/vbaProject.bin"],
    });
  });
  it("rejects duplicate slide, shape, relationship or part identity", () => {
    reject(
      edit("ppt/presentation.xml", (s) => s.replace('id="256"', 'id="512"')),
      "invalid",
    );
    reject(
      edit(SLIDE, (s) => s.replace('id="14" name=', 'id="11" name=')),
      "invalid",
    );
    reject(
      edit("ppt/slides/_rels/slide2.xml.rels", (s) =>
        s.replace('Id="rImage"', 'Id="rLayout"'),
      ),
      "invalid",
    );
    const f = pptxFixture();
    reject({ ...f, entries: [...f.entries, f.entries[0]] }, "invalid");
  });
  it("rejects missing images, path escapes, wrong main type and malformed numbers", () => {
    const f = pptxFixture();
    reject(
      {
        ...f,
        entries: f.entries.filter((p) => p !== "ppt/media/quadrants.png"),
        parts: f.parts.filter((p) => p.name !== "ppt/media/quadrants.png"),
      },
      "invalid",
    );
    reject(
      edit("_rels/.rels", (s) =>
        s.replace("ppt/presentation.xml", "../../escape.xml"),
      ),
      "invalid",
    );
    reject(
      edit("[Content_Types].xml", (s) =>
        s.replace(
          "presentationml.presentation.main+xml",
          "presentationml.slideshow.main+xml",
        ),
      ),
    );
    reject(
      edit(SLIDE, (s) =>
        s.replace('x="914400" y="1828800"', 'x="NaN" y="1828800"'),
      ),
      "invalid",
    );
  });
  it.each([
    "ppt/slides/slide2.xml",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/theme/theme1.xml",
  ])("rejects wrong role MIME for %s", (part) => {
    reject(
      edit("[Content_Types].xml", (s) =>
        s.replace(
          new RegExp(
            `(<Override PartName="/${part.replaceAll(".", "\\.")}" ContentType=")[^"]+`,
          ),
          "$1text/plain",
        ),
      ),
    );
  });
  it("rejects geometry/resource limits instead of clamping and silently succeeding", () => {
    reject(
      edit("ppt/presentation.xml", (s) =>
        s.replace('cx="9144000"', 'cx="9525009525"'),
      ),
      "limit",
    );
    reject(
      edit(SLIDE, (s) =>
        s.replace('x="914400" y="1828800"', 'x="9525009525" y="1828800"'),
      ),
      "limit",
    );
    reject(
      edit(SLIDE, (s) => s.replace('sz="3200"', 'sz="307201"')),
      "limit",
    );
    reject(
      {
        ...pptxFixture(),
        entries: Array.from({ length: 2049 }, (_, i) => `entry${i}`),
      },
      "limit",
    );
  });
  it("marks approximate paragraph formatting partial and preserves literal data", () => {
    const d = parsePptx(
      edit(SLIDE, (s) =>
        s
          .replace(
            '<a:pPr algn="l"/>',
            '<a:pPr algn="l"><a:spcAft><a:spcPts val="300"/></a:spcAft></a:pPr>',
          )
          .replace("LAYOUT THEME 01", " 0 false &amp; 中文 "),
      ),
    );
    expect(texts(find(d.slides[0].shapes, "2"))?.[0].text).toBe(
      " 0 false & 中文 ",
    );
    expect(d.partial).toBe(true);
    expect(d.warnings.some((w) => w.code === "unsupportedFormatting")).toBe(
      true,
    );
  });
});
