import { build } from "vite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const output = await mkdtemp(join(tmpdir(), "farfold-visual-feedback-build-"));
await writeFile(
  "docs/evidence/2026-10-09-capability-hardening/visual-feedback/browser/temporary-build-path.json",
  JSON.stringify({ output }, null, 2),
);
await build({
  configFile: "vite.config.ts",
  build: {
    outDir: output,
    emptyOutDir: true,
    rollupOptions: {
      input:
        "docs/evidence/2026-10-09-capability-hardening/visual-feedback/browser/index.html",
    },
  },
});
console.log(JSON.stringify({ output }));
