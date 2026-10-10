import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const base =
  "docs/evidence/2026-10-09-capability-hardening/worktree-native-followup/new11/independent";
const baseline = process.argv[2] === "baseline";
const old = fs.readFileSync(
  base + "/baseline/EmptyState.tsx.before.txt",
  "utf8",
);
if (
  createHash("sha256").update(old).digest("hex") !==
  "a3115244a86a87310e9fc84cf5d8dde46cfeee2a3b0bedab0fd149b0bbdf6748"
)
  throw Error("baseline changed");
const source = path.resolve("src/components/EmptyState.tsx");
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: "output/2026-10-10-new11-browser/.vite",
  plugins: baseline
    ? [
        {
          name: "exact-old-source-evidence",
          enforce: "pre",
          load(id) {
            return id.split("?")[0] === source ? old : null;
          },
        },
      ]
    : [],
  optimizeDeps: { entries: [base + "/browser/index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1480,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log(
  JSON.stringify({
    pid: process.pid,
    port: 1480,
    baseline,
    overlaySha256: baseline
      ? createHash("sha256").update(old).digest("hex")
      : null,
  }),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
