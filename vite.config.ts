import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";

// This installed dependency exports an official non-DOM entry for workers.
// Resolve through the actual locked dependency tree rather than a pnpm layout.
// One exact alias also keeps Vite's shared dev prebundle safe in both contexts.
const markdown = createRequire(import.meta.url).resolve("react-markdown");
const remarkParse = createRequire(markdown).resolve("remark-parse");
const fromMarkdown = createRequire(remarkParse).resolve(
  "mdast-util-from-markdown",
);
const namedReferences = createRequire(fromMarkdown).resolve(
  "decode-named-character-reference",
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^decode-named-character-reference$/,
        replacement: namedReferences,
      },
    ],
  },
  optimizeDeps: { entries: ["index.html"] },
  clearScreen: false,
  worker: { format: "es" },
  server: {
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
