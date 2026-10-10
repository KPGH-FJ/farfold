import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillChangeReview } from "./SkillChangeReview";
import { skillManagement } from "../runtime/skill_management_controller";
import { operation, request } from "../runtime/mcp_add.test-support";
import type { McpAddRequest } from "../runtime/mcp_add_types";
const owner = { agentId: request.agentId, token: {}, current: () => true };
const url =
  "HTTPS://Endpoint.test:000443/mcp?token=VISIBLE_CANARY&x=&x=+&slash=%2f&html=<script>bad()</script>";
function state() {
  const r: McpAddRequest = {
    ...request,
    target: { ...request.target, transport: "streamableHttp" },
  };
  const op = operation(r, true);
  const review = { ...op.review!, mutation: "addDisabledHttpMcp" as const };
  return {
    ...skillManagement.get(owner.agentId),
    request: r,
    review,
    operation: { ...op, review },
    additionInput: {
      transport: "streamableHttp" as const,
      name: r.target.name,
      url,
    },
  };
}
function render() {
  return renderToStaticMarkup(
    <SkillChangeReview owner={owner} agentId={owner.agentId} active />,
  );
}
afterEach(() => vi.restoreAllMocks());
it("shows all raw HTTP bytes in quoted escaped text, without a link, media or network action", () => {
  const view = state();
  vi.spyOn(skillManagement, "get").mockReturnValue(view);
  vi.spyOn(skillManagement, "canConfirm").mockReturnValue(true);
  const confirm = vi.spyOn(skillManagement, "confirm");
  const fetch = vi.spyOn(globalThis, "fetch");
  const html = render();
  expect(html).toContain("添加 HTTP MCP");
  expect(html).toContain(
    "<code>&quot;HTTPS://Endpoint.test:000443/mcp?token=VISIBLE_CANARY&amp;x=&amp;x=+&amp;slash=%2f&amp;html=&lt;script&gt;bad()&lt;/script&gt;&quot;</code>",
  );
  expect(html).not.toMatch(/<(?:a|img|iframe|script)\b/);
  expect(html).toContain("确认添加并保持停用");
  expect(html).toContain("不连接该地址");
  expect(confirm).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("a retired HTTP review cannot recover raw URL or a confirmation control from safe metadata", () => {
  const view = state();
  vi.spyOn(skillManagement, "get").mockReturnValue({
    ...view,
    additionInput: null,
    review: null,
    reviewRetired: true,
  });
  vi.spyOn(skillManagement, "canConfirm").mockReturnValue(false);
  const html = render();
  expect(html).not.toContain("VISIBLE_CANARY");
  expect(html).not.toContain("确认添加并保持停用");
  expect(html).toContain(request.target.name);
});
