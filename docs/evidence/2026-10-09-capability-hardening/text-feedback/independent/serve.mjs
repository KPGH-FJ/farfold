import { createServer } from "vite";
import { createHash } from "node:crypto";
const baseline = process.argv[2] === "baseline-css";
const port = baseline ? 1461 : 1460;
const server = await createServer({
  configFile: "vite.config.ts",
  cacheDir: `output/2026-10-10-text-feedback-independent/.vite-${port}`,
  plugins: baseline
    ? [
        {
          name: "independent-historical-css",
          enforce: "pre",
          transform(code, id) {
            if (
              !id
                .split("?")[0]
                .endsWith("/src/components/SourceTextSelection.css")
            )
              return;
            const original = code
              .replace("  -webkit-user-select: text;\n", "")
              .replace("  user-select: text;\n", "");
            const hash = createHash("sha256").update(original).digest("hex");
            if (
              hash !==
              "736406514e966f65465cb62f2fd1e7b0e1ff5d287c4b451407d07c573e2c9b2e"
            )
              throw new Error("historical CSS mismatch");
            console.log("Read-only original CSS:", hash);
            return original;
          },
        },
      ]
    : [],
  optimizeDeps: {
    entries: [
      "docs/evidence/2026-10-09-capability-hardening/text-feedback/independent/index.html",
    ],
  },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    watch: { ignored: ["**/output/**", "**/src-tauri/**", "**/.git/**"] },
  },
});
await server.listen();
console.log(
  `Text feedback independent server ${port} ready; PID ${process.pid}`,
);
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, async () => {
    await server.close();
    process.exit(0);
  });
