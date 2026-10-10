import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/workbook-range/independent";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-workbook-range/.vite",
  optimizeDeps: {
    entries: [base + "/index.html", base + "/worker.html"],
    include: ["saxes"],
  },
  server: {
    host: "127.0.0.1",
    port: 1466,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log("Owned full-app rectangle Vite PID " + process.pid);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
