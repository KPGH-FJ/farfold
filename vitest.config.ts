import { mergeConfig } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // The standalone design prototype uses its own Node test runner.
      exclude: [...configDefaults.exclude, "src-tauri/target/**", ".design/**"],
    },
  }),
);
