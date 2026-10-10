import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "docs/evidence/2026-10-09-capability-hardening/worktree-remove/independent/wire/publication.test.ts",
    ],
    environment: "node",
  },
});
