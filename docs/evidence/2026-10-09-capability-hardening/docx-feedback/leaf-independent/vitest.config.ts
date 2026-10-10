import { mergeConfig, defineConfig } from "vitest/config";
import base from "../../../../../vite.config";
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        "docs/evidence/2026-10-09-capability-hardening/docx-feedback/leaf-independent/same-file-replacement.test.tsx",
      ],
    },
  }),
);
