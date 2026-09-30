import assert from "node:assert/strict";
import test from "node:test";
import {
  permissionChangeState,
  permissionOption,
  permissionOptions,
} from "../src/permission-state.js";

const capability = {
  id: "returned-setting",
  label: "权限",
  options: [
    { value: "ask", label: "请求批准" },
    { value: "full", label: "完全访问", requiresConfirmation: true },
  ],
};

test("没有可用能力不产生默认权限，也不把第一项当作未知的当前值", () => {
  assert.deepEqual(permissionOptions(), []);
  assert.deepEqual(permissionOptions({ options: false }), []);
  assert.equal(permissionOption(capability, "unreturned"), undefined);
  assert.equal(permissionOption(capability), undefined);
  assert.equal(permissionOption(capability, "ask"), capability.options[0]);
});

test("能力仅接受有效且不重复的返回选项，保留扩大权限标记", () => {
  assert.deepEqual(
    permissionOptions({
      options: [
        null,
        { label: "没有值" },
        { value: "", label: "空值" },
        { value: "blank", label: " " },
        ...capability.options,
        { value: "ask", label: "重复" },
      ],
    }),
    capability.options,
  );
  assert.equal(permissionOption(capability, "full").requiresConfirmation, true);
});

test("新草稿与已完成工作可改权限，普通未发送队列不被当作已提交请求", () => {
  for (const status of ["draft", "done", "stopped", "failed"])
    assert.deepEqual(
      permissionChangeState({
        status,
        queue: [{ text: "尚未发送" }],
        queuePaused: true,
      }),
      { disabled: false, reason: "" },
    );
  assert.equal(permissionChangeState({ pendingMessages: [] }).disabled, false);
});

test("运行、审批、问题与停止等待均禁止更改已接纳工作的权限", () => {
  for (const status of [
    "running",
    "submitting",
    "stopping",
    "approval",
    "question",
  ])
    assert.equal(permissionChangeState({ status }).disabled, true, status);
  for (const stopPhase of ["waiting", "pending", "unknown"])
    assert.equal(
      permissionChangeState({ status: "done", stopPhase }).disabled,
      true,
      stopPhase,
    );
  assert.equal(permissionChangeState({ stopping: true }).disabled, true);
});

test("已提交而未确认的请求和权限请求待确认时禁止再次提交", () => {
  for (const context of [
    { pending: true },
    { pendingMessages: [{ id: "submitted" }] },
  ])
    assert.equal(
      permissionChangeState({ status: "done" }, context).disabled,
      true,
    );
  for (const patch of [
    { pending: true },
    { permissionPending: true },
    { permissionChange: { phase: "pending" } },
    { permissionChange: { phase: "unknown" } },
    { pendingMessages: [{ id: "submitted" }] },
    { admissionUnknown: true },
    { terminalUnknown: true },
    { terminalState: "unknown" },
    { status: "unknown" },
    { status: "recovery" },
  ])
    assert.equal(
      permissionChangeState({ status: "done", ...patch }).disabled,
      true,
      JSON.stringify(patch),
    );
});

test("只读、断线、身份不全和历史正文未恢复不会被完成状态绕开", () => {
  for (const patch of [
    { readOnly: true },
    { connectionState: "lost" },
    { connectionBroken: true },
    { identityIncomplete: true },
    { identityIssue: "model-mismatch" },
    { historyIncomplete: true },
    { recoveryRead: { phase: "loading" } },
    { recoveryRead: { phase: "failed" } },
  ]) {
    const state = permissionChangeState({ status: "done", ...patch });
    assert.equal(state.disabled, true, JSON.stringify(patch));
    assert.ok(state.reason);
  }
  for (const context of [
    { connectionBroken: true },
    { identityIssue: true },
    { historyIncomplete: true },
  ])
    assert.equal(
      permissionChangeState({ status: "done" }, context).disabled,
      true,
    );
  assert.equal(
    permissionChangeState({
      status: "done",
      recoveryRead: { phase: "complete" },
    }).disabled,
    false,
  );
});

test("控件隐藏未提供能力的入口，未确认值与只读入口不伪装可用权限", async () => {
  const [
    { createServer },
    { default: React },
    { renderToStaticMarkup },
    { fileURLToPath },
  ] = await Promise.all([
    import("vite"),
    import("react"),
    import("react-dom/server"),
    import("node:url"),
  ]);
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-permission-control-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const Component = (await server.ssrLoadModule("/src/PermissionControl.jsx"))
      .default;
    const render = (props) =>
      renderToStaticMarkup(React.createElement(Component, props));
    assert.equal(render({}), "");
    assert.equal(render({ capability: { options: [] }, value: "full" }), "");
    const unknown = render({ capability, value: "missing", onChange() {} });
    assert.ok(unknown.includes("权限未确认"));
    assert.ok(!unknown.includes("请求批准"));
    const readOnly = render({
      capability,
      value: "ask",
      disabled: true,
      disabledReason: "这条对话仅可查看",
    });
    assert.ok(readOnly.includes("请求批准"));
    assert.ok(readOnly.includes("这条对话仅可查看"));
    assert.ok(
      !/<button[^>]*\sdisabled/.test(readOnly),
      "只读仍允许打开查看可用选项与原因",
    );
  } finally {
    await server.close();
  }
});
