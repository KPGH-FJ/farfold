import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/independent/browser";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-h15-independent/.vite",
  optimizeDeps: { entries: [base + "/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1476,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log("Owned H15 full App Vite PID " + process.pid);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
