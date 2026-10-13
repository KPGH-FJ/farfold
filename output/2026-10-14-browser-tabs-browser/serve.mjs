import { createServer } from "vite";
const base = "output/2026-10-14-browser-tabs-browser";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: base + "/.vite",
  optimizeDeps: { entries: [base + "/index.html"], include: ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"] },
  server: {
    host: "127.0.0.1",
    port: 1540,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log(
  JSON.stringify({
    pid: process.pid,
    port: 1540,
    scope:
      "Owned complete production App controlled P30 tabs IPC; no real Agent or formal App",
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
