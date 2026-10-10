import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "docs/evidence/2026-10-09-capability-hardening/worktree-recycle/independent/wire-check/wire.test.ts",
    ],
    environment: "node",
  },
});
