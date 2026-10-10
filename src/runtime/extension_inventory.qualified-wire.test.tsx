import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentExtensionInventoryResult } from "../components/AgentExtensionInventoryResult";
import { parseInventoryOperation } from "./extension_inventory_types";
import { EXTENSION_INVENTORY_STRINGS as S } from "./extension_inventory_strings";

// Actual controlled peer -> Rust process/decoder/Request serialization, not a
// live official program or installed-application result.
const wire = JSON.parse(
  readFileSync("src/runtime/fixtures/skills-qualified-wire.json", "utf8"),
);
const expected = {
  agentId: wire.agentId,
  requestId: wire.requestId,
  cwd: wire.cwd,
  kind: wire.kind,
};

it("accepts the actual qualified-skill wire without changing names, status or identity", () => {
  expect(parseInventoryOperation(wire, expected)).toEqual(wire);
  expect(
    wire.snapshot.items.map((item: { name: string }) => item.name),
  ).toEqual([
    "sample:search",
    "documents:documents",
    "sample:search",
    "ordinary-name",
  ]);
  expect(wire.snapshot.items[1].reportedEnabled).toBe(false);
  expect(wire.snapshot.items[2].pluginReported).toBe(false);
  expect(() =>
    parseInventoryOperation(wire, { ...expected, kind: "mcp" }),
  ).toThrow();
});

it("shows every actual reported name as plain text, retaining duplicates and disabled state", () => {
  const parsed = parseInventoryOperation(wire, expected);
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={{ cwd: parsed.cwd, snapshot: parsed.snapshot!, stale: false }}
      stale={false}
    />,
  );
  expect(html.match(/<li>/g)).toHaveLength(4);
  expect(html.match(/<strong>sample:search<\/strong>/g)).toHaveLength(2);
  expect(html).toContain("<strong>documents:documents</strong>");
  expect(html).toContain("<strong>ordinary-name</strong>");
  expect(html).toContain(S.skillDisabled);
  expect(html).not.toContain(S.unnamed);
  expect(html).not.toMatch(/<(a|button|input|form)\b/);
  expect(html).not.toContain("href=");
});
