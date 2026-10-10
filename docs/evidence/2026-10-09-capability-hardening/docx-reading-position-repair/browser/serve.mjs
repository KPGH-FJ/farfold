import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
const base =
  "docs/evidence/2026-10-09-capability-hardening/docx-reading-position-repair/browser";
const baseline = process.argv[2] === "baseline";
const snapshots = JSON.parse(fs.readFileSync(base + "/baseline/inputs.json"));
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-docx-reading-position/.vite",
  plugins: baseline
    ? [
        {
          name: "owned-committed-reading-replay",
          enforce: "pre",
          load(id) {
            const relative = path.relative(process.cwd(), id.split("?")[0]);
            const item = snapshots.files.find((x) => x.path === relative);
            if (item) return fs.readFileSync(item.snapshot, "utf8");
          },
        },
      ]
    : [],
  optimizeDeps: { entries: [base + "/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1467,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log(JSON.stringify({ pid: process.pid, baseline, port: 1467 }));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
