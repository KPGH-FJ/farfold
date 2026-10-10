import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "docs/evidence/2026-10-09-capability-hardening/extension-inventory/independent/expired-tracking.test.ts",
    ],
  },
});
