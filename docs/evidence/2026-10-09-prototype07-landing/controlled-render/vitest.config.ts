import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      "docs/evidence/2026-10-09-prototype07-landing/controlled-render/*.test.tsx",
    ],
    environment: "node",
    exclude: [],
  },
});
