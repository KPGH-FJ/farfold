import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "docs/evidence/2026-10-09-capability-hardening/visual-area/independent/parent-reentry.test.ts",
    ],
    environment: "node",
    reporters: "default",
  },
});
