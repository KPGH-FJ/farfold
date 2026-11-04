import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      "output/2026-11-04-p01-storage-bridge/frontend-storage-bridge.test.ts",
    ],
    testTimeout: 60_000,
  },
});
