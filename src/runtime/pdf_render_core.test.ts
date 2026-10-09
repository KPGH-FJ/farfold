import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canvasFactory,
  PassiveFilterFactory,
  pdfCanvasSize,
  renderPdfPixels,
} from "./pdf_render_core";
import { MAX_PREVIEW_PIXELS } from "./visual_preview";
import { fixture } from "./fixtures/pdf-preview/fixture";
// Node-only independent pixel check using PDF.js's optional native canvas.
// This is not a browser Worker or installed WebKit test.
const require = createRequire(import.meta.resolve("pdfjs-dist"));
const native = require("@napi-rs/canvas");
const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
let warned = false;
beforeEach(() => {
  warned = false;
  vi.spyOn(console, "warn").mockImplementation(() => {
    warned = true;
  });
  vi.spyOn(console, "error").mockImplementation(() => {
    warned = true;
  });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(width: number, height: number) {
        const canvas = native.createCanvas(width, height);
        canvas.transferToImageBitmap = () => ({
          width: canvas.width,
          height: canvas.height,
          pixels: canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data,
          close: vi.fn(),
        });
        return canvas;
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      const folder = path.includes("standard_fonts/")
        ? "standard_fonts"
        : path.includes("cmaps/")
          ? "cmaps"
          : "wasm";
      const bytes = await readFile(
        join(packageRoot, folder, path.split("/").at(-1)!),
      );
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      };
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const bytes = async (name: string) =>
  new Uint8Array(
    await readFile(new URL(`./fixtures/pdf-preview/${name}`, import.meta.url)),
  );
async function draw(name: string, page = 1) {
  return renderPdfPixels(await bytes(name), page, 360, undefined, () => warned);
}
it.each([
  ["mixed-two-pages.pdf", 1],
  ["mixed-two-pages.pdf", 2],
  ["embedded-chinese.pdf", 1],
])(
  "renders real fixture %s page %i into nonblank pixels",
  async (name, page) => {
    const result = await draw(name, page);
    expect(warned).toBe(false);
    const bitmap = result.bitmap as unknown as {
      pixels: Uint8Array;
      width: number;
      height: number;
    };
    expect(bitmap.width).toBe(360);
    expect(bitmap.height).toBe(480);
    const colored = bitmap.pixels.filter(
      (v, i) => i % 4 !== 3 && v < 240,
    ).length;
    expect(colored).toBeGreaterThan(500);
  },
);
it("gives an explicit failure for encrypted, damaged and missing Chinese glyph resources", async () => {
  await expect(draw("password.pdf")).rejects.toThrow("password");
  await expect(draw("damaged.pdf")).rejects.toThrow();
  warned = false;
  expect(
    await draw("unembedded-chinese.pdf").then(
      () => "rendered",
      (error) => error.message,
    ),
  ).toBe("incomplete");
});
it("bounds page canvases and aggregate temporary canvas allocation", () => {
  const size = pdfCanvasSize(100_000, 100_000, 100_000);
  expect(size.width * size.height).toBeLessThanOrEqual(MAX_PREVIEW_PIXELS);
  expect(() => pdfCanvasSize(Infinity, 1, 800)).toThrow();
  const Factory = canvasFactory(),
    factory = new Factory();
  const first = factory.create(4096, 4096),
    second = factory.create(4096, 4096);
  expect(() => factory.create(1, 1)).toThrow("limit");
  factory.destroy(first);
  factory.destroy(second);
  expect(factory.create(1, 1).canvas.width).toBe(1);
});
it("does not silently discard required SVG color/alpha filtering", () => {
  const factory = new PassiveFilterFactory();
  expect(factory.addFilter(null)).toBe("none");
  expect(() => factory.addFilter([[1]])).toThrow("unsupported");
  expect(() => factory.addAlphaFilter()).toThrow("unsupported");
});
it("refuses a malformed embedded font and an image beyond the parser's pixel limit", async () => {
  const badFont = fixture(
    "BT /F1 12 Tf 10 10 Td (hello) Tj ET",
    "/Font << /F1 5 0 R >>",
    [
      "<< /Type /Font /Subtype /Type1 /BaseFont /Broken /FontDescriptor 6 0 R >>",
      "<< /Type /FontDescriptor /FontName /Broken /Flags 4 /FontBBox [0 0 10 10] /ItalicAngle 0 /Ascent 10 /Descent 0 /CapHeight 10 /StemV 1 /FontFile 7 0 R >>",
      "<< /Length 3 /Length1 3 >>\nstream\nabc\nendstream",
    ],
  );
  expect(
    await renderPdfPixels(badFont, 1, 200, undefined, () => warned).then(
      () => "rendered",
      () => "failed",
    ),
  ).toBe("failed");
  warned = false;
  const largeImage = fixture(
    "q 200 0 0 200 0 0 cm /Im1 Do Q",
    "/XObject << /Im1 5 0 R >>",
    [
      "<< /Type /XObject /Subtype /Image /Width 8193 /Height 8193 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream",
    ],
  );
  expect(
    await renderPdfPixels(largeImage, 1, 200, undefined, () => warned).then(
      () => "rendered",
      () => "failed",
    ),
  ).toBe("failed");
});

it("restores a formerly valid page to the new last page only when restoration was requested", async () => {
  const result = await renderPdfPixels(
    await bytes("mixed-two-pages.pdf"),
    99,
    360,
    undefined,
    () => warned,
    true,
  );
  expect(result.pages).toBe(2);
  expect(result.pageNumber).toBe(2);
  result.bitmap.close();
  await expect(
    renderPdfPixels(
      await bytes("mixed-two-pages.pdf"),
      99,
      360,
      undefined,
      () => warned,
    ),
  ).rejects.toThrow("unsupported");
});
