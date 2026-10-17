import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentExtensionInventoryResult } from "./AgentExtensionInventoryResult";
import type { InventoryResult } from "../runtime/extension_inventory_controller";

it.each(["unavailable", "reviewable"] as const)(
  "keeps original extra discovery scope visible and read-only despite %s row authority",
  (availability) => {
    const inspect = vi.fn();
    const result: InventoryResult = {
      request: {
        kind: "skills",
        agentId: "fixture",
        requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        cwd: "/old/project",
        extraSkillRoots: ["/old/技能🙂"],
      },
      owner: { agentId: "fixture", token: {}, current: () => false },
      cwd: "/old/project",
      stale: true,
      snapshot: {
        observedAtMs: 1000,
        scope: "officialSkillsForDirectory",
        source: "officialAppServer",
        complete: true,
        sessionApplicability: "unverified",
        errorCount: 0,
        items: [
          {
            id: 0,
            name: "sample:search",
            description: null,
            descriptionTruncated: false,
            descriptionRedacted: false,
            reportedEnabled: true,
            origin: "user",
            pluginReported: false,
            enablement:
              availability === "reviewable"
                ? { availability, reason: null }
                : { availability, reason: "discoveryOnly" },
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <AgentExtensionInventoryResult
        result={result}
        stale
        management={{ enabled: true, inspect }}
      />,
    );
    expect(html).toContain("/old/project");
    expect(html).toContain("/old/技能🙂");
    expect(html).toContain("仅本次查询");
    expect(html).toContain("只读");
    expect(html).toContain("已过期");
    expect(html).not.toContain("<button");
    expect(inspect).not.toHaveBeenCalled();
  },
);
