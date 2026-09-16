import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CodexAcpModelPanel } from "./CodexAcpModelPanel";
import { CodexModelFields } from "./CodexModelFields";
const scope = {
  runtimeProductId: "codex" as const,
  installationId: "i",
  runtimeBuildId: "b",
  adapterId: "codex-acp-stdio-v1" as const,
  adapterBuildId: "a",
  connectionId: "c",
  profileId: "p",
  generation: 1,
};
it("production model panel contains no actionable catalog/model inputs or IPC", () => {
  const request = vi.fn();
  const html = renderToStaticMarkup(
    <CodexAcpModelPanel
      scope={scope}
      viewKey="v"
      port={{ allowed: false, bound: false, current: () => true, request }}
    />,
  );
  expect(html).toContain("选择入口暂未开放");
  expect(html).not.toMatch(/<(button|input|select)/);
  expect(request).not.toHaveBeenCalled();
});
it("shared fields preserve Direct display and selection without changing provider integration", () => {
  const html = renderToStaticMarkup(
    <CodexModelFields
      models={[
        {
          id: "id",
          model: "native",
          displayName: "DIRECT MODEL",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
      ]}
      modelId="id"
      effort="medium"
      disabled={false}
      effortDisabled={false}
      onModel={() => {}}
      onEffort={() => {}}
    />,
  );
  expect(html).toContain("DIRECT MODEL");
  expect(html).toContain('value="id"');
  expect(html).toContain('value="medium"');
  expect(html).not.toContain("Provider");
});
