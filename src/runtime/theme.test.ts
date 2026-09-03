import { describe, expect, it } from "vitest";
import { parseThemeMode, resolveTheme } from "./theme";

describe("parseThemeMode", () => {
  it("accepts only the three product theme modes", () => {
    expect(parseThemeMode("system")).toBe("system");
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
    expect(parseThemeMode("sepia")).toBe("system");
    expect(parseThemeMode(null)).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("resolves system dynamically and leaves explicit choices stable", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
