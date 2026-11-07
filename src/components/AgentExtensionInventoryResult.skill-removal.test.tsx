import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExtensionInventoryResult } from "./AgentExtensionInventoryResult";
import type { InventoryResult } from "../runtime/extension_inventory_controller";
import type { SkillsInventory } from "../runtime/extension_inventory_types";

const snapshot: SkillsInventory = {
  source: "officialAppServer",
  scope: "officialSkillsForDirectory",
  observedAtMs: 1,
  complete: true,
  sessionApplicability: "unverified",
  errorCount: 0,
  items: [
    {
      id: 0,
      name: "owned-skill",
      description: null,
      descriptionTruncated: false,
      descriptionRedacted: false,
      reportedEnabled: false,
      origin: "repo",
      pluginReported: false,
      enablement: { availability: "reviewable", reason: null },
    },
  ],
};
const result: InventoryResult = {
  cwd: "/controlled",
  stale: false,
  owner: { agentId: "controlled", token: {}, current: () => true },
  request: {
    agentId: "controlled",
    kind: "skills",
    cwd: "/controlled",
    requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  },
  snapshot,
};
it("offers explicit preference-clear review without enabling the skill or dispatching", () => {
  const inspect = vi.fn();
  const html = renderToStaticMarkup(
    <AgentExtensionInventoryResult
      result={result}
      stale={false}
      skillPreferenceRemoval={{ enabled: true, inspect }}
    />,
  );
  expect(html).toContain("审阅清除启停偏好…");
  expect(html).toContain("报告：未启用");
  expect(inspect).not.toHaveBeenCalled();
  expect(html).not.toContain("已恢复默认");
});
it("blocks stale and inactive reports and keeps extra-directory discovery readonly", () => {
  const props = {
    result,
    skillPreferenceRemoval: { enabled: false, inspect: vi.fn() },
  };
  expect(
    renderToStaticMarkup(<AgentExtensionInventoryResult {...props} stale />),
  ).toMatch(/disabled=""[^>]*>审阅清除启停偏好…/);
  const discovery = {
    ...result,
    request: { ...result.request, extraSkillRoots: ["/extra"] },
  };
  expect(
    renderToStaticMarkup(
      <AgentExtensionInventoryResult
        {...props}
        result={discovery}
        stale={false}
      />,
    ),
  ).not.toContain("审阅清除启停偏好…");
});
it("does not grant clear authority to partial or plugin-managed skill reports", () => {
  for (const next of [
    { ...snapshot, complete: false, errorCount: 1 },
    { ...snapshot, items: [{ ...snapshot.items[0], pluginReported: true }] },
    {
      ...snapshot,
      items: [{ ...snapshot.items[0], origin: "system" as const }],
    },
  ]) {
    const html = renderToStaticMarkup(
      <AgentExtensionInventoryResult
        result={{ ...result, snapshot: next }}
        stale={false}
        skillPreferenceRemoval={{ enabled: true, inspect: vi.fn() }}
      />,
    );
    expect(html).not.toContain("审阅清除启停偏好…");
  }
});
