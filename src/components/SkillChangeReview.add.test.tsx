import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillChangeReview } from "./SkillChangeReview";
import { skillManagement } from "../runtime/skill_management_controller";
const owner = { agentId: "add-review", token: {}, current: () => true };
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function reviewed(
  additionInput = {
    name: "local-test",
    executablePath: "/Applications/Local Tools/runner",
    args: ["", "two words", "<img src=x onerror=alert(1)>", "a\\b"],
  },
) {
  const target = {
    kind: "mcpAddition",
    inventoryRequestId: id,
    inputId: id,
    name: "local-test",
    transport: "stdio",
  };
  const request = {
    agentId: owner.agentId,
    requestId: id,
    action: "inspect",
    cwd: "/controlled",
    target,
    requestedEnabled: false,
    operationId: null,
  };
  const review = {
    reviewId: id,
    agentId: owner.agentId,
    cwd: request.cwd,
    target,
    requestedEnabled: false,
    configuredEnabled: null,
    reportedEnabled: null,
    writeScope: { kind: "user", configDisplayPath: "~/.example/config.toml" },
    observedAtMs: Date.now(),
    validForMs: 300000,
    mutation: "addDisabledStdioMcp",
    nameAvailability: "absentInCheckedScopes",
    preservation: "otherConfigurationSemanticsPreserved",
    sessionApplicability: "unverified",
  };
  const state = {
    request,
    review,
    operation: {
      ...request,
      review,
      state: "ready",
      phase: "complete",
      settled: true,
      writeDispatched: false,
      writeAck: "none",
      outcome: null,
      code: null,
      observation: null,
    },
    reviewRetired: false,
    unresolved: false,
    checking: false,
    cancelRequested: false,
    trackingReleased: false,
    admissionRejected: false,
    error: null,
    additionInput,
  };
  vi.spyOn(skillManagement, "get").mockReturnValue(
    state as unknown as ReturnType<typeof skillManagement.get>,
  );
  vi.spyOn(skillManagement, "canConfirm").mockReturnValue(true);
  const confirm = vi.spyOn(skillManagement, "confirm").mockReturnValue(true);
  return {
    confirm,
    render: () =>
      renderToStaticMarkup(
        <SkillChangeReview owner={owner} agentId={owner.agentId} active />,
      ),
  };
}
afterEach(() => vi.restoreAllMocks());
it("shows absent saved/report values without presenting them as an existing disabled preference", () => {
  const h = reviewed(),
    html = h.render();
  expect(html).toContain("所检查范围中尚无此名称");
  expect(html).not.toContain("用户配置中的偏好：停用");
  expect(html).not.toContain("此文件夹的配置报告：停用");
  expect(html).toContain("确认添加并保持停用");
  expect(h.confirm).not.toHaveBeenCalled();
});
it("reviews the exact local path and every ordered argument as plain text before separate confirmation", () => {
  const html = reviewed().render();
  expect(html).toContain("/Applications/Local Tools/runner");
  expect(html).toContain("空字符串");
  expect(html).toContain("two words");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toContain("<img");
  expect(html).toContain("a\\\\b");
  expect(html).toContain("不启动填写的程序");
});

it("shows visible boundaries for empty, literal, whitespace and quoted path/arguments", () => {
  const html = reviewed({
    name: "local-test",
    executablePath: '/Applications/Tool "quoted" ',
    args: ["", "空字符串", " leading ", 'a"b'],
  }).render();
  expect(html).toContain("<code>&quot;&quot;</code>");
  expect(html).toContain("<code>&quot;空字符串&quot;</code>");
  expect(html).toContain("<code>&quot; leading &quot;</code>");
  expect(html).toContain("<code>&quot;a\\&quot;b&quot;</code>");
  expect(html).toContain(
    "<code>&quot;/Applications/Tool \\&quot;quoted\\&quot; &quot;</code>",
  );
});
