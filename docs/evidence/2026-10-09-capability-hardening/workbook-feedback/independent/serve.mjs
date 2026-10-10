import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/workbook-feedback/independent";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-workbook-feedback/.vite",
  optimizeDeps: { entries: [base + "/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1464,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log("Owned full-app workbook Vite PID " + process.pid);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
