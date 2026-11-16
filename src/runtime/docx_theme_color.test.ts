import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseDocx } from "./docx_parse";
import { docxFixtureBytes, replaceDocxPart } from "./docx_fixture";
import type { DocxParagraph } from "./docx_types";
const input = () =>
  docxFixtureBytes(
    readFileSync(
      new URL("./fixtures/docx-search/theme-colors.docx", import.meta.url),
    ),
  );
const colors = (capture = input()) =>
  parseDocx(capture)
    .blocks.filter((b): b is DocxParagraph => b.kind === "paragraph")
    .map((p) => (p.runs[0].kind === "text" ? p.runs[0].style.color : null));
// MS-OI29500 2.1.72(c): 4F81BD + themeTint 99 -> 95B3D7.
// https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/8229a077-7fc8-4fba-96cc-c77b6a4fc768
it("matches the official Word theme tint example in a real DOCX package", () => {
  expect(colors()[0]).toBe("#95B3D7");
});
it("preserves tint endpoints and Word's tint precedence over shade", () => {
  expect(colors().slice(1)).toEqual(["#FFFFFF", "#4F81BD", "#95B3D7"]);
});
it("uses background themeFill and its modifier separately from foreground themeColor", () => {
  const table = parseDocx(input()).blocks.find((b) => b.kind === "table");
  if (!table || table.kind !== "table") throw Error("Missing table");
  // Default Word accent2 C0504D with 60% luminance modulation.
  expect(table.rows[0].cells[0].background).toBe("#D99694");
});
it("does not apply a theme modifier without a theme color", () => {
  const capture = replaceDocxPart(input(), "word/document.xml", (xml) =>
    xml.replaceAll('w:val="000000" w:themeColor="accent1"', 'w:val="123456"'),
  );
  expect(colors(capture)).toEqual(["#123456", "#123456", "#123456", "#123456"]);
});
it("applies shade to HSL luminance and preserves its endpoints", () => {
  let capture = replaceDocxPart(input(), "word/theme/theme1.xml", (xml) =>
    xml.replace(/(<a:accent1>\s*<a:srgbClr) val="4F81BD"/, '$1 val="FF0000"'),
  );
  capture = replaceDocxPart(capture, "word/document.xml", (xml) =>
    xml
      .replaceAll("w:themeTint=", "w:themeShade=")
      .replace('w:themeShade="99" w:themeShade="40"', 'w:themeShade="80"'),
  );
  expect(colors(capture)).toEqual(["#990000", "#000000", "#FF0000", "#800000"]);
});
it("reports an invalid selected modifier without inventing a different color", () => {
  const capture = replaceDocxPart(input(), "word/document.xml", (xml) =>
    xml.replaceAll('w:themeTint="99"', 'w:themeTint="ZZ"'),
  );
  expect(colors(capture)[0]).toBe("#4F81BD");
  expect(
    parseDocx(capture).warnings.some((w) => w.code === "unsupportedFormatting"),
  ).toBe(true);
});
it.each([
  ["solid", "#4F81BD"],
  ["nil", undefined],
] as const)(
  "uses the %s shading pattern rather than always displaying the background fill",
  (pattern, expected) => {
    const capture = replaceDocxPart(input(), "word/document.xml", (xml) =>
      xml.replace(
        'w:val="clear" w:themeColor="accent1"',
        `w:val="${pattern}" w:themeColor="accent1"`,
      ),
    );
    const table = parseDocx(capture).blocks.find((b) => b.kind === "table");
    if (!table || table.kind !== "table") throw Error("Missing table");
    expect(table.rows[0].cells[0].background).toBe(expected);
  },
);
it("marks an unsupported table shading pattern as simplified", () => {
  const capture = replaceDocxPart(input(), "word/document.xml", (xml) =>
    xml.replace(
      'w:val="clear" w:themeColor="accent1"',
      'w:val="pct20" w:themeColor="accent1"',
    ),
  );
  const plain =
    parseDocx(input()).warnings.find((w) => w.code === "unsupportedFormatting")
      ?.count ?? 0;
  const changed =
    parseDocx(capture).warnings.find((w) => w.code === "unsupportedFormatting")
      ?.count ?? 0;
  expect(changed).toBe(plain + 1);
});
