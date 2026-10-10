import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/loaded-history-search/independent";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-loaded-search-independent/.vite",
  optimizeDeps: { entries: [base + "/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1472,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log("Owned loaded search full-App Vite PID " + process.pid);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
