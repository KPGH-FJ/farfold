import { afterEach, expect, it, vi } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { MAX_PREVIEW_PIXELS } from "./visual_preview";

import { fixture } from "./fixtures/pdf-preview/fixture";

async function operators(bytes: Uint8Array, stopAtErrors = true) {
  const loading = getDocument({
    data: bytes,
    stopAtErrors,
    maxImageSize: MAX_PREVIEW_PIXELS,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const pdf = await loading.promise;
    return await (await pdf.getPage(1)).getOperatorList();
  } finally {
    await loading.destroy();
  }
}
afterEach(() => vi.restoreAllMocks());

it("parses a genuine vector page without reading a document URL", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const result = await operators(fixture("0 0 1 rg 10 10 100 100 re f"));
  expect(result.fnArray.length).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("demonstrates that operator-list completion alone cannot certify a too-large image was rendered", async () => {
  const create = () =>
    fixture("q 200 0 0 200 0 0 cm /Im1 Do Q", "/XObject << /Im1 5 0 R >>", [
      "<< /Type /XObject /Subtype /Image /Width 8193 /Height 8193 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream",
    ]);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const permissive = await operators(create(), false);
  expect(permissive.fnArray).not.toContain(OPS.paintImageXObject);
  expect(warning).toHaveBeenCalled();
  warning.mockClear();
  const strict = await operators(create());
  expect(strict.fnArray).not.toContain(OPS.paintImageXObject);
});

it("identifies a bad font warning even when the strict parser completes its operator list", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await operators(
    fixture("BT /F1 12 Tf 10 10 Td (hello) Tj ET", "/Font << /F1 5 0 R >>", [
      "<< /Type /Font /Subtype /Type1 /BaseFont /Broken /FontDescriptor 6 0 R >>",
      "<< /Type /FontDescriptor /FontName /Broken /Flags 4 /FontBBox [0 0 10 10] /ItalicAngle 0 /Ascent 10 /Descent 0 /CapHeight 10 /StemV 1 /FontFile 7 0 R >>",
      "<< /Length 3 /Length1 3 >>\nstream\nabc\nendstream",
    ]),
  );
  expect(warning).toHaveBeenCalled();
});

it("does not execute JavaScript OpenAction or fetch a link while preparing page pixels", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const marker = vi.fn();
  vi.stubGlobal("farfoldPdfFixtureExecuted", marker);
  try {
    await operators(
      fixture(
        "10 10 20 20 re f",
        "",
        [
          "<< /S /JavaScript /JS (globalThis.farfoldPdfFixtureExecuted\\(\\); fetch\\('https://example.invalid/private'\\)) >>",
        ],
        "/OpenAction 5 0 R",
      ),
    );
    expect(marker).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
