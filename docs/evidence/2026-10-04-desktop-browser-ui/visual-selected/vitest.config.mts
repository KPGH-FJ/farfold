import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  cacheDir:
    "/Users/tw/Documents/Codex/2026-10-03/task-3/production-ui-20261004/visual-selected/.vite-cache",
  plugins: [react()],
  test: { include: ["desktop-render.test.tsx"], environment: "node" },
});
