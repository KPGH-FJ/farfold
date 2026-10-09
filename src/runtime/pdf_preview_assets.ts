/** These URLs are emitted from this exact locked package. Document-controlled
 * names can only select an existing asset; they cannot create a fetch URL. */
const assets = import.meta.glob<string>(
  [
    "../../node_modules/pdfjs-dist/cmaps/*.bcmap",
    "../../node_modules/pdfjs-dist/standard_fonts/*.pfb",
    "../../node_modules/pdfjs-dist/standard_fonts/*.ttf",
    "../../node_modules/pdfjs-dist/wasm/openjpeg.wasm",
    "../../node_modules/pdfjs-dist/wasm/jbig2.wasm",
    "../../node_modules/pdfjs-dist/wasm/qcms_bg.wasm",
  ],
  { eager: true, query: "?url", import: "default" },
);
const folders: Record<string, string> = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
};
export function pdfAssetUrl(kind: string, filename: string): string {
  const folder = Object.hasOwn(folders, kind) ? folders[kind] : undefined;
  if (!folder || !/^[a-zA-Z0-9_.-]+$/.test(filename))
    throw new Error("Unsupported PDF resource");
  const path = `../../node_modules/pdfjs-dist/${folder}/${filename}`;
  if (!Object.hasOwn(assets, path)) throw new Error("Unsupported PDF resource");
  return assets[path];
}
export function pdfAssetFactory(signal: AbortSignal) {
  return class {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const response = await fetch(pdfAssetUrl(kind, filename), {
        signal,
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) throw new Error("PDF resource unavailable");
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}
