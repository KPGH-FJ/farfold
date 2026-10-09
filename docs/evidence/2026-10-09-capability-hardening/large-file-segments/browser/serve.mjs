import { createServer } from "vite";
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-large-file-segments/.vite",
  server: { host: "127.0.0.1", port: 1460, strictPort: true },
});
await server.listen();
console.log("Large-file fixture 1460 ready");
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, async () => {
    await server.close();
    process.exit(0);
  });
