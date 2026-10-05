import { mergeConfig } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Research downloads and frozen evidence are not Farfold test inputs.
      include: [
        "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
        "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      ],
      // The standalone design prototype uses its own Node test runner.
      exclude: [...configDefaults.exclude, "src-tauri/target/**", ".design/**"],
    },
  }),
);
