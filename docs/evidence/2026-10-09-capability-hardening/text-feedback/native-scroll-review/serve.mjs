import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/text-feedback/native-scroll-review";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-native-scroll-review/.vite",
  optimizeDeps: { entries: [base + "/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1463,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log("Owned full-app layout Vite PID " + process.pid);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
