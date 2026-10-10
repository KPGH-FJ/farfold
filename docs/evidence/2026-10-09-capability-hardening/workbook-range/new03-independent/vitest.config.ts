import { mergeConfig, defineConfig } from "vitest/config";
import base from "../../../../../vitest.config.ts";
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "docs/evidence/2026-10-09-capability-hardening/workbook-range/new03-independent/navigation-reentry.test.tsx",
      ],
    },
  }),
);
