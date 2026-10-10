import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExtensionInventoryResult } from "./AgentExtensionInventoryResult";
import type { SkillsInventory } from "../runtime/extension_inventory_types";
import { EXTENSION_INVENTORY_STRINGS as S } from "../runtime/extension_inventory_strings";

const snapshot: SkillsInventory = {
  observedAtMs: 1000,
  source: "officialAppServer",
  scope: "officialSkillsForDirectory",
  complete: false,
  sessionApplicability: "unverified",
  errorCount: 2,
  items: [
    {
      id: 0,
      name: null,
      description:
        '<a href="https://example.invalid">not a link</a>\n[not a link](https://example.invalid)',
      descriptionTruncated: true,
      descriptionRedacted: true,
      reportedEnabled: false,
      origin: "repo",
      pluginReported: true,
    },
  ],
};
it("renders skills as plain text with disabled, source, partial and filtering reports", () => {
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={{ cwd: "/controlled", snapshot, stale: true }}
      stale
    />,
  );
  for (const text of [
    S.unnamed,
    S.skillDisabled,
    S.origins.repo,
    S.partial,
    S.descriptionTruncated,
    S.descriptionRedacted,
    S.stale,
  ])
    expect(html).toContain(text);
  expect(html).toContain("&lt;a href=");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain(S.empty);
});
it("does not turn a partial result without readable items into an empty complete report", () => {
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={{
        cwd: "/controlled",
        snapshot: { ...snapshot, items: [] },
        stale: false,
      }}
      stale={false}
    />,
  );
  expect(html).toContain(S.partial);
  expect(html).not.toContain(S.skillEmpty);
  expect(html).not.toContain(S.empty);
});
it("keeps duplicate reported names as distinct rows and shows a complete empty list accurately", () => {
  const items = [0, 1].map((id) => ({
    ...snapshot.items[0],
    id,
    name: "Same",
  }));
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={{
        cwd: "/controlled",
        snapshot: { ...snapshot, items },
        stale: false,
      }}
      stale={false}
    />,
  );
  expect(html.match(/<li>/g)).toHaveLength(2);
  const empty = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={{
        cwd: "/controlled",
        snapshot: { ...snapshot, items: [], complete: true, errorCount: 0 },
        stale: false,
      }}
      stale={false}
    />,
  );
  expect(empty).toContain(S.skillEmpty);
  expect(empty).not.toContain(S.partial);
});
