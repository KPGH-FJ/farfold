import { createServer } from "vite";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const baseline = process.argv[2] === "baseline";
const folder = dirname(fileURLToPath(import.meta.url));
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: `output/2026-10-10-inspect-review/.vite-${baseline ? "baseline" : "fixed"}`,
  plugins: [
    {
      name: "readonly-baseline-input",
      enforce: "pre",
      async load(id) {
        if (
          baseline &&
          id.split("?")[0] === resolve("src/runtime/file_delivery.ts")
        )
          return await readFile(
            resolve(folder, "baseline-file_delivery.ts"),
            "utf8",
          );
      },
    },
  ],
  server: { host: "127.0.0.1", port: 1464, strictPort: true },
});
await server.listen();
console.log(
  `Inspection ${baseline ? "baseline" : "fixed"} fixture 1464 ready; PID ${process.pid}`,
);
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, async () => {
    await server.close();
    process.exit(0);
  });
