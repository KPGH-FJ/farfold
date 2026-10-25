import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPdfInputDiagnosticGate,
  extractPdfInput,
} from "./pdf_input_core";
import { pdfRequest } from "./pdf_input_fixture.test-support";
import { PdfNodeParserPort } from "./pdf_input_node_worker.test-support";
import { pdfSearchText } from "./pdf_search_text";
import { pdfInputText } from "./pdf_input_text";
import { fixture } from "./fixtures/pdf-preview/fixture";

/** Changing font flushes a real TextItem while preserving the PDF text advance.
 * This exact operator stream is also rendered in the owned visual fixture. */
function splitWordPdf(tailPosition = "") {
  return fixture(
    `BT /F1 24 Tf 24 100 Td (need) Tj /F2 24 Tf ${tailPosition}(le) Tj ET`,
    "/Font << /F1 5 0 R /F2 6 0 R >>",
    [
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ],
  );
}
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
        throw new Error("unexpected resource");
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
async function extract(data = splitWordPdf()) {
  const port = new PdfNodeParserPort();
  await port.ready();
  const gate = createPdfInputDiagnosticGate(
    port as unknown as Worker,
    port.owner,
  );
  try {
    return await extractPdfInput(
      data,
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

it("finds a visually contiguous word split by a real PDF font switch", async () => {
  const result = await extract();
  expect(result.pages[0].items.map((item) => item.text)).toEqual([
    "need",
    "le",
  ]);
  expect(
    result.pages[0].items.every((item) => item.dir === "ltr" && !item.hasEOL),
  ).toBe(true);
  const search = pdfSearchText(result);
  expect(
    search.segments.filter((segment) => segment.text.includes("needle")),
  ).toHaveLength(1);
  expect(search.bytes).toBe(6);
  expect(failed).toBe(false);
});

it("keeps the existing fragment-local match count without duplicating a joined run", async () => {
  const search = pdfSearchText(await extract());
  expect(
    search.segments.flatMap((segment) => [...segment.text.matchAll(/need/gu)]),
  ).toHaveLength(1);
  expect(search.bytes).toBe(6);
});
it("retains actual parser geometry only as temporary metadata, not Agent input", async () => {
  const result = await extract();
  expect(result.pages[0].items[0].geometry).toEqual({
    transform: [24, 0, 0, 24, 24, 100],
    width: 53.376,
    height: 24,
  });
  expect(result.pages[0].items[1].geometry?.transform[4]).toBeCloseTo(
    77.376,
    10,
  );
  const body = JSON.parse(pdfInputText(result).text.split("\n\n").at(-1)!);
  expect(body.pages[0].items).toEqual([
    { text: "need", dir: "ltr", hasEOL: false },
    { text: "le", dir: "ltr", hasEOL: false },
  ]);
});
it.each([
  ["column gap", "1 0 0 1 140 100 Tm ", 140, 100],
  ["different line", "1 0 0 1 24 60 Tm ", 24, 60],
] as const)(
  "does not join words separated by a real PDF %s",
  async (_label, position, x, y) => {
    const result = await extract(splitWordPdf(position));
    const authored = result.pages[0].items.filter((i) => /\S/u.test(i.text));
    expect(authored.map((i) => i.text)).toEqual(["need", "le"]);
    expect(authored[1].geometry?.transform.slice(4)).toEqual([x, y]);
    const search = pdfSearchText(result);
    expect(search.segments.some((s) => s.text.includes("needle"))).toBe(false);
    expect(
      search.segments.flatMap((s) => [...s.text.matchAll(/need/gu)]),
    ).toHaveLength(1);
    expect(failed).toBe(false);
  },
);
