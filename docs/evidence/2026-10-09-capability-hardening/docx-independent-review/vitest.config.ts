import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "docs/evidence/2026-10-09-capability-hardening/docx-independent-review/*.test.tsx",
    ],
  },
});
