import { createServer } from "vite";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-p20-parent-browser/.vite",
  server: { host: "127.0.0.1", port: 1459, strictPort: true },
});
await server.listen();
console.log("P20 parent controlled IPC browser ready on 1459");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
