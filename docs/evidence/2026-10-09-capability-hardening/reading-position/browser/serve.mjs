import { createServer } from "vite";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-reading-position/.vite",
  plugins: [
    {
      name: "controlled-office-data",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          importer?.endsWith("WorkbookFilePreview.tsx") &&
          source.endsWith("runtime/xlsx_preview")
        )
          return "\0office-workbook";
        if (
          importer?.endsWith("DocxFilePreview.tsx") &&
          source.endsWith("runtime/docx_preview")
        )
          return "\0office-document";
      },
      load(id) {
        if (id === "\0office-workbook")
          return `export const readWorkbookCapture=(f,s)=>globalThis.fixture.capture(f,s);export const readWorkbookPreview=(c,id,s)=>globalThis.fixture.workbook(c,id,s);`;
        if (id === "\0office-document")
          return `export const readDocxCapture=(f,s)=>globalThis.fixture.capture(f,s);export const readDocxPreview=(c,s)=>globalThis.fixture.document(c,s);`;
      },
    },
  ],
  server: { host: "127.0.0.1", port: 1458, strictPort: true },
});
await server.listen();
console.log("Reading position fixture 1458 ready");
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, async () => {
    await server.close();
    process.exit(0);
  });
