import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(
    new URL("../../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
const directives = new Map<string, string[]>(
  (config.app.security.csp as string)
    .split(";")
    .filter((value) => value.trim())
    .map((value) => {
      const [name, ...sources] = value.trim().split(/\s+/);
      return [name, sources];
    }),
);

describe("document image production policy", () => {
  it("allows captured Blob images alongside the existing local image sources", () => {
    expect(directives.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "asset:",
      "http://asset.localhost",
    ]);
  });

  it("does not grant Blob execution, Worker, connection or document loading", () => {
    for (const [name, sources] of directives) {
      if (name === "img-src") continue;
      expect(sources, name).not.toContain("blob:");
    }
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "ipc:",
      "http://ipc.localhost",
    ]);
  });
});
