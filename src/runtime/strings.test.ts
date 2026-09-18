import { describe, expect, it } from "vitest";
import { STRINGS } from "./strings";

// PRODUCT.md §5 禁用词：不得出现在任何用户可见字符串中。
const FORBIDDEN =
  /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i;

function collectStrings(value: unknown, path: string[]): [string, string][] {
  if (typeof value === "string") return [[path.join("."), value]];
  if (typeof value === "function") {
    const fn = value as (arg: unknown) => string;
    // Cover both number- and string-taking formatters.
    return [
      [path.join("."), fn(2)],
      [path.join("."), fn("1.2.3")],
      [path.join("."), fn("/tmp/example")],
    ];
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => collectStrings(child, [...path, key]),
    );
  }
  return [];
}

describe("strings", () => {
  const leaves = collectStrings(STRINGS, ["STRINGS"]);

  it("contains real copy", () => {
    expect(leaves.length).toBeGreaterThan(50);
    for (const [path, text] of leaves) {
      expect(text.trim().length, path).toBeGreaterThan(0);
    }
  });

  it("contains no forbidden vocabulary", () => {
    const offenders = leaves.filter(([, text]) => FORBIDDEN.test(text));
    expect(offenders).toEqual([]);
  });
});
