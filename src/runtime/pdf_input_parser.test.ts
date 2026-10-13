import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPdfInputDiagnosticGate,
  extractPdfInput,
} from "./pdf_input_core";
import { pdfInputText } from "./pdf_input_text";
import { pdfFixture, pdfRequest } from "./pdf_input_fixture.test-support";
import { PdfNodeParserPort } from "./pdf_input_node_worker.test-support";
import { fixture } from "./fixtures/pdf-preview/fixture";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
let failed = false;
beforeEach(() => {
  failed = false;
  vi.spyOn(console, "warn").mockImplementation(() => {
    failed = true;
  });
  vi.spyOn(console, "error").mockImplementation(() => {
    failed = true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      const folder = path.includes("standard_fonts/")
        ? "standard_fonts"
        : path.includes("cmaps/")
          ? "cmaps"
          : null;
      if (!folder || /^https?:/i.test(path))
        throw new Error("unexpected test resource request");
      const bytes = await readFile(
        join(packageRoot, folder, path.split("/").at(-1)!),
      );
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      };
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function read(
  bytes: Uint8Array,
  holdLive = false,
  cleanupDiagnostic = false,
) {
  const port = new PdfNodeParserPort(holdLive, cleanupDiagnostic);
  await port.ready();
  const gate = createPdfInputDiagnosticGate(
    port as unknown as Worker,
    port.owner,
  );
  try {
    return await extractPdfInput(
      bytes,
      pdfRequest,
      port as unknown as Worker,
      gate,
      () => failed,
    );
  } finally {
    gate.dispose();
    await port.terminate();
  }
}
it("extracts all three original pages through a real parser thread, including hidden/OCR-layer text without executing actions", async () => {
  const result = await read(await pdfFixture());
  expect(result.scope.readPageNumbers).toEqual([1, 2, 3]);
  expect(result.pages.map((p) => p.decodedRotation)).toEqual([0, 90, 0]);
  expect(result.pages.map((p) => p.items.map((i) => i.text).join(""))).toEqual([
    "PAGE_ONE_VISIBLEINVISIBLE_TR3ZERO_ALPHAWHITE_ON_WHITELOCAL_CLIP_HIDDENOFF_LAYER_TEXT",
    "PAGE_TWO_ROTATEDOCR_LABEL_NOT_ON_IMAGE",
    "PAGE_THREE_TAIL",
  ]);
  expect(result.partial).toBe(true);
  expect(result.warnings).toHaveLength(4);
  expect(pdfInputText(result).actualTextChars).toBe(137);
  expect(failed).toBe(false);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([url]) => !/^https?:/i.test(String(url))),
  ).toBe(true);
});
it("preserves ligatures, mapped Unicode and returned fallback without claiming the unknown glyph was reconstructed", async () => {
  const result = await read(
    await pdfFixture("02-encoding-ligature-unmapped.pdf"),
  );
  expect(result.pages[0].items.map((i) => i.text).join("")).toBe("fiﬁ中🚀g");
  expect(result.warnings).toContainEqual({
    code: "textDecodingUnverified",
    count: 1,
    unit: "scope",
  });
});
it("retains the image-only page as no decoded author text, with no OCR or generated-text success", async () => {
  const result = await read(await pdfFixture("03-image-only.pdf"));
  expect(result.pages[0].items).toEqual([]);
  expect(result.warnings.at(-1)).toEqual({
    code: "pagesWithoutText",
    count: 1,
    unit: "pages",
  });
  expect(pdfInputText(result).actualTextChars).toBe(0);
});
it("rejects the original encrypted file without providing its public fixture password", async () => {
  await expect(
    read(await pdfFixture("04-encrypted.pdf")),
  ).rejects.toMatchObject({ code: "encrypted" });
});
it("rejects a real damaged second page even when live notices are held until the same-port post-destroy snapshot", async () => {
  await expect(
    read(await pdfFixture("05-late-page-damaged.pdf"), true),
  ).rejects.toMatchObject({ code: "incomplete" });
  expect(failed).toBe(false); // No coordinator diagnostic needed to hide the prefix.
});
it("rejects a test-controlled cleanup-phase diagnostic using the actual official destroy barrier", async () => {
  await expect(read(await pdfFixture(), true, true)).rejects.toMatchObject({
    code: "incomplete",
  });
});
it("applies the global 256KiB bound to the genuine two-page 300000-byte document", async () => {
  await expect(
    read(await pdfFixture("06-whole-utf8-over-limit.pdf")),
  ).rejects.toMatchObject({ code: "textLimit" });
});
it("detects saved XFA while rendering is disabled instead of trusting isPureXfa=false", async () => {
  const xml =
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="own"/></template>';
  const bytes = fixture(
    "",
    "",
    [`<< /Length ${xml.length} >>\nstream\n${xml}\nendstream`],
    "/NeedsRendering true /AcroForm << /XFA 5 0 R >>",
  );
  await expect(read(bytes)).rejects.toMatchObject({ code: "unsupported" });
});
