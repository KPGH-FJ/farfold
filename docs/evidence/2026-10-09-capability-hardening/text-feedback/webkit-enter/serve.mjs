import { createServer } from "vite";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-text-feedback-webkit/.vite",
  optimizeDeps: {
    entries: [
      "docs/evidence/2026-10-09-capability-hardening/text-feedback/webkit-enter/index.html",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 1462,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log(`Source WebKit fixture ready at 1462, PID ${process.pid}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
