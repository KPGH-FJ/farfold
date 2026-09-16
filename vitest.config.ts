import { mergeConfig } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // The maintained Pi adapter uses node:test and runs separately in the root test script.
      exclude: [
        ...configDefaults.exclude,
        "src-tauri/target/**",
        "src-tauri/pi-acp-adapter/**",
      ],
    },
  }),
);
