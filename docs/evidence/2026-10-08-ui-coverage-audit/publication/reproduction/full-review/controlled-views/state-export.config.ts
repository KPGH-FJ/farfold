import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      "docs/evidence/2026-10-08-ui-coverage-audit/full-review/controlled-views/state-export.test.tsx",
    ],
    environment: "node",
    maxWorkers: 1,
  },
});
