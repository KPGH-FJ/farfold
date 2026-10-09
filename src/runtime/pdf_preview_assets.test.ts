import { afterEach, expect, it, vi } from "vitest";
import { pdfAssetFactory, pdfAssetUrl } from "./pdf_preview_assets";
afterEach(() => vi.unstubAllGlobals());
it("selects only packaged resources, never a document-controlled URL or script engine", () => {
  expect(pdfAssetUrl("standardFontDataUrl", "FoxitSerif.pfb")).toContain(
    "FoxitSerif",
  );
  expect(pdfAssetUrl("wasmUrl", "openjpeg.wasm")).toContain("openjpeg");
  for (const [kind, name] of [
    ["wasmUrl", "quickjs-eval.wasm"],
    ["wasmUrl", "https://example.com/a"],
    ["cMapUrl", "../secret"],
    ["__proto__", "a"],
    ["cMapUrl", "missing"],
  ])
    expect(() => pdfAssetUrl(kind, name)).toThrow();
});
it("uses cancellable local-only asset selection and does not follow redirects", async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
  }));
  vi.stubGlobal("fetch", fetcher);
  const abort = new AbortController(),
    Factory = pdfAssetFactory(abort.signal);
  expect(
    await new Factory().fetch({ kind: "wasmUrl", filename: "jbig2.wasm" }),
  ).toEqual(new Uint8Array([1, 2]));
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), {
    signal: abort.signal,
    credentials: "omit",
    redirect: "error",
  });
  await expect(
    new Factory().fetch({
      kind: "wasmUrl",
      filename: "https://example.com/evil",
    }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
