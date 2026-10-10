import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-docx-feedback/.vite",
  optimizeDeps: { entries: [base + "/worker.html"] },
  server: {
    host: "127.0.0.1",
    port: 1464,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log("Owned DOCX position Vite PID " + process.pid);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
