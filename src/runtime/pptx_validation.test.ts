import { afterEach, expect, it, vi } from "vitest";
import { checkedPptxDocument } from "./pptx_validation";
import { decodePptxImages } from "./pptx_decode";
import { pptxDisplayFixture, pptxTestCapture } from "./pptx_display_fixture";
import type { PptxDocument } from "./pptx_types";
const parts = () => new Set(pptxTestCapture().parts.map((part) => part.name));
afterEach(() => vi.unstubAllGlobals());
it("accepts literal text, negative coordinates, and repeated inherited shapes on separate slides", () => {
  const d = pptxDisplayFixture(true);
  const inherited = {
    ...d.slides[0].shapes[0],
    id: "master",
    source: {
      part: "ppt/slideMasters/slideMaster1.xml",
      shapeId: "9",
      layer: "master" as const,
    },
  };
  d.slides.forEach((slide) => slide.shapes.unshift(inherited));
  expect(checkedPptxDocument(d, parts())).toBe(d);
});
it.each([
  (d: PptxDocument) => ({ ...d, html: "<img src=https://example.invalid>" }),
  (d: PptxDocument) => ({ ...d, width: Infinity }),
  (d: PptxDocument) => ({ ...d, width: 1_000_001 }),
  (d: PptxDocument) => ({ ...d, width: 1_000_000, height: 1000 }),
  (d: PptxDocument) => ({ ...d, slides: [] }),
  (d: PptxDocument) => ({ ...d, slides: [d.slides[0], d.slides[0]] }),
  (d: PptxDocument) => {
    d.slides[0].shapes[0].box.x = NaN;
    return d;
  },
  (d: PptxDocument) => {
    d.slides[0].shapes[0].box.width = -1;
    return d;
  },
  (d: PptxDocument) => {
    d.slides[0].shapes[0].source.part = "uncaptured.xml";
    return d;
  },
  (d: PptxDocument) => {
    d.slides[0].shapes.push(d.slides[0].shapes[0]);
    return d;
  },
  (d: PptxDocument) => {
    const s = d.slides[0].shapes[0];
    if (s.kind === "shape") s.fill = "url(https://example.invalid)";
    return d;
  },
  (d: PptxDocument) => {
    const s = d.slides[0].shapes[0];
    if (s.kind === "shape") {
      s.geometry = null;
    }
    return d;
  },
  (d: PptxDocument) => {
    const s = d.slides[0].shapes[0];
    if (s.kind === "shape" && s.text) {
      const r = s.text.paragraphs[0].runs[0];
      if (r.kind === "text") r.fontSize = 0;
    }
    return d;
  },
  (d: PptxDocument) => {
    const s = d.slides[0].shapes[0];
    if (s.kind === "shape" && s.text) {
      const r = s.text.paragraphs[0].runs[0];
      if (r.kind === "text") r.fontFamily = "url(https://example.invalid)";
    }
    return d;
  },
  (d: PptxDocument) => ({ ...d, partial: true }),
  (d: PptxDocument) => ({
    ...d,
    warnings: [{ code: "unsupportedContent", count: 1 }],
  }),
  (d: PptxDocument) => ({
    ...d,
    warnings: [{ code: "hyperlinks", count: 1, slideId: "unknown" }],
  }),
  (d: PptxDocument) => ({ ...d, images: [...d.images, ...d.images] }),
  (d: PptxDocument) => {
    d.images[0].id = "not-in-capture.png";
    return d;
  },
  (d: PptxDocument) => {
    d.images[0].width++;
    return d;
  },
  (d: PptxDocument) => {
    d.images[0].bytes = new Uint8Array([1, 2, 3]);
    return d;
  },
])("rejects malformed/unbounded models before DOM adoption %#", (mutate) => {
  expect(() =>
    checkedPptxDocument(mutate(pptxDisplayFixture(true)), parts()),
  ).toThrow();
});
it("bounds empty paragraphs across all shapes rather than only each array", () => {
  const document = pptxDisplayFixture();
  const first = document.slides[0].shapes[0],
    second = document.slides[1].shapes[0];
  if (
    first.kind !== "shape" ||
    !first.text ||
    second.kind !== "shape" ||
    !second.text
  )
    throw Error("test fixture");
  first.text.paragraphs = Array.from({ length: 100000 }, () => ({
    alignment: "left" as const,
    runs: [],
  }));
  second.text.paragraphs = [{ alignment: "left", runs: [] }];
  expect(() => checkedPptxDocument(document, parts())).toThrowError("limit");
});
it("permits an accurately warned partial preview", () => {
  const d = pptxDisplayFixture();
  d.partial = true;
  d.warnings = [
    { code: "unsupportedContent", count: 1, slideId: d.slides[0].id },
  ];
  expect(checkedPptxDocument(d, parts())).toBe(d);
});
it("requires an actual bitmap decoder only when images exist", async () => {
  vi.stubGlobal("createImageBitmap", undefined);
  await decodePptxImages(pptxDisplayFixture());
  await expect(
    decodePptxImages(pptxDisplayFixture(true)),
  ).rejects.toMatchObject({ code: "unsupported" });
});
it("decodes only local PNG/JPEG blobs and immediately closes each bitmap", async () => {
  const close = vi.fn(),
    decode = vi.fn().mockResolvedValue({ width: 16, height: 16, close });
  vi.stubGlobal("createImageBitmap", decode);
  await decodePptxImages(pptxDisplayFixture(true));
  expect(decode.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(decode.mock.calls[0][0].type).toBe("image/png");
  expect(close).toHaveBeenCalledOnce();
  decode.mockResolvedValue({ width: 17, height: 16, close });
  await expect(
    decodePptxImages(pptxDisplayFixture(true)),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(close).toHaveBeenCalledTimes(2);
  decode.mockRejectedValue(Error("private decoder"));
  await expect(
    decodePptxImages(pptxDisplayFixture(true)),
  ).rejects.toMatchObject({ code: "invalid", message: "invalid" });
});
