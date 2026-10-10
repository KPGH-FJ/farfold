import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExtensionInventoryResult } from "../components/AgentExtensionInventoryResult";
import {
  parseInventoryOperation,
  type InventoryOperation,
  type SkillsInventory,
} from "./extension_inventory_types";
import { ready, request } from "./extension_inventory.test-support";
import { EXTENSION_INVENTORY_STRINGS as S } from "./extension_inventory_strings";

const expected = { ...request, kind: "skills" as const };
function reported(names: readonly (string | null)[]): InventoryOperation & {
  snapshot: SkillsInventory;
} {
  return {
    ...expected,
    state: "ready",
    settled: true,
    snapshot: {
      observedAtMs: 1000,
      source: "officialAppServer",
      scope: "officialSkillsForDirectory",
      complete: true,
      sessionApplicability: "unverified",
      errorCount: 0,
      items: names.map((name, id) => ({
        id,
        name,
        description: null,
        descriptionTruncated: false,
        descriptionRedacted: false,
        reportedEnabled: id !== 1,
        origin: "user",
        pluginReported: true,
      })),
    },
  };
}

it("accepts exactly one namespace separator without weakening ordinary names", () => {
  const value = reported([
    "sample:search",
    "documents:documents",
    "资料_2:查找-甲.1",
    "ordinary name",
    "旧名称",
    null,
  ]);
  expect(parseInventoryOperation(value, expected)).toEqual(value);
});

it("applies the 256 UTF-8 byte limit to the complete qualified name", () => {
  const name = "é".repeat(126) + ":abc";
  expect(new TextEncoder().encode(name)).toHaveLength(256);
  const value = reported([name]);
  expect(parseInventoryOperation(value, expected)).toEqual(value);
  expect(() =>
    parseInventoryOperation(reported([name + "a"]), expected),
  ).toThrow();
});

it("rejects empty segments, extra separators, whitespace, controls and path or URL syntax", () => {
  for (const name of [
    ":search",
    "sample:",
    "sample::search",
    "a:b:c",
    "two words:search",
    "sample:two words",
    "sample:\tsearch",
    "sample:search\n",
    "sample:\u0000search",
    "sample:\u202esearch",
    "sample:..",
    "../sample:search",
    "sample:folder/file",
    "sample:folder\\file",
    "https://example.invalid",
    "file:///private/secret",
    "sample:<a>",
  ])
    expect(
      () => parseInventoryOperation(reported([name]), expected),
      name,
    ).toThrow();
});

it("leaves MCP name acceptance unchanged", () => {
  const value = ready();
  value.snapshot.items[0].name = "ordinary name";
  expect(parseInventoryOperation(value, request)).toEqual(value);
  for (const name of ["sample:search", "documents:documents", "a:b:c"]) {
    value.snapshot.items[0].name = name;
    expect(() => parseInventoryOperation(value, request), name).toThrow();
  }
});

it("renders parsed qualified names as distinct report rows, never links or commands", () => {
  const operation = parseInventoryOperation(
    reported(["sample:search", "documents:documents", "sample:search"]),
    expected,
  );
  expect(operation.snapshot).toBeDefined();
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={{
        cwd: expected.cwd,
        snapshot: operation.snapshot!,
        stale: false,
      }}
      stale={false}
    />,
  );
  expect(html.match(/<strong>sample:search<\/strong>/g)).toHaveLength(2);
  expect(html).toContain("<strong>documents:documents</strong>");
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).toContain(S.skillDisabled);
  expect(html).not.toContain(S.unnamed);
  expect(html).not.toMatch(/<(a|button|input|form)\b/);
  expect(html).not.toContain("href=");
});
