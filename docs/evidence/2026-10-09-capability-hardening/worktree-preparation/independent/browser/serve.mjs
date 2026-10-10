import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-preparation/independent/browser";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-h17-browser/.vite",
  optimizeDeps: { entries: [base + "/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1481,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log(JSON.stringify({ pid: process.pid, port: 1481 }));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
