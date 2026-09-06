import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("development and internal installation profiles", () => {
  it("keeps the default CLI launch out of the daily-use profile", () => {
    const defaults = readJson("../src-tauri/tauri.conf.json");
    expect(defaults.identifier).toBe("ai.farfold.desktop.dev");
    expect(defaults.productName).toBe("Farfold Dev");
    expect(defaults.app.windows[0].title).toBe("Farfold Dev");
    expect(defaults.plugins.updater.endpoints).toEqual([]);
  });

  it("requires an explicit internal build without importing QA configuration", () => {
    const scripts = readJson("../package.json").scripts;
    expect(scripts["tauri:build:internal"]).toBe(
      "tauri build --config src-tauri/tauri.internal.conf.json",
    );
    const internal = readJson("../src-tauri/tauri.internal.conf.json");
    const defaults = readJson("../src-tauri/tauri.conf.json");
    const merged = { ...defaults, ...internal };
    expect(merged.identifier).toBe("ai.farfold.desktop");
    expect(merged.productName).toBe("Farfold");
    expect(merged.app.windows[0].title).toBe("Farfold");
    expect(merged.plugins.updater.endpoints).toEqual([]);
    expect(merged.plugins.updater.pubkey).toBe("");
  });
});
