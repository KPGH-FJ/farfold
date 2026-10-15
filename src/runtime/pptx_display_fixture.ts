/** Handwritten display model for boundary/lifecycle tests, not a parser oracle. */
import { pptxFixture } from "./pptx_fixture";
import type { PptxCapture, PptxDocument, PptxShape } from "./pptx_types";
export const pptxTestFile = {
  root: "/fixture",
  path: "/fixture/a.pptx",
  resolvedPath: "/fixture/a.pptx",
  name: "a.pptx",
  size: 7091,
  version: "one",
  sha256: "a".repeat(64),
};
export function pptxTestCapture(): PptxCapture {
  const input = pptxFixture();
  return { ...input, file: { ...pptxTestFile }, inflatedBytes: 20000 };
}
export function pptxDisplayFixture(withImage = false): PptxDocument {
  const shape = (part: string, text: string): PptxShape => ({
    kind: "shape",
    id: `${part}#2`,
    source: { part, shapeId: "2", layer: "slide" },
    box: { x: -10, y: 20, width: 300, height: 100 },
    geometry: "rect",
    fill: "#123456",
    stroke: { color: "#000000", width: 2 },
    text: {
      inset: { top: 4, right: 4, bottom: 4, left: 4 },
      wrap: "square",
      verticalAlign: "center",
      paragraphs: [
        {
          alignment: "left",
          runs: [
            {
              kind: "text",
              text,
              fontFamily: "Arial",
              fontSize: 24,
              color: "#FFFFFF",
              bold: false,
              italic: false,
              underline: false,
            },
          ],
        },
      ],
    },
  });
  const slides = ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"].map(
    (part, at) => ({
      id: String(256 + at),
      part,
      background: "#FFFFFF",
      shapes: [
        shape(part, at ? "第二页文字" : "<script>literal & 中文🙂</script>"),
      ],
    }),
  );
  const document: PptxDocument = {
    width: 960,
    height: 540,
    slides,
    images: [],
    warnings: [],
    partial: false,
  };
  if (withImage) {
    const part = pptxFixture().parts.find(
      (part) => part.name === "ppt/media/quadrants.png",
    )!;
    document.images.push({
      id: part.name,
      mimeType: "image/png",
      bytes: Uint8Array.from(Buffer.from(part.data, "base64")),
      width: 16,
      height: 16,
    });
    slides[0].shapes.push({
      kind: "image",
      id: "image",
      source: { part: slides[0].part, shapeId: "3", layer: "slide" },
      box: { x: 300, y: 100, width: 40, height: 60 },
      imageId: part.name,
    });
  }
  return document;
}
