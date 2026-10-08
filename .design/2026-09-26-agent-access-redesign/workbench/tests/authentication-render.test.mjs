import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { normalizeAgent } from "../src/agent-setup-state.js";
import { startAgentJob } from "../src/access-jobs.js";
let server, Authentication, Setup;
const terminal = {
  id: "terminal",
  type: "terminal",
  presentation: "terminal",
  label: "交互式登录",
};
const device = {
  id: "device",
  type: "agent",
  presentation: "device",
  label: "设备码授权",
  expiresInMs: 300000,
};
const agent = normalizeAgent({
  id: "example",
  name: "示例 Agent",
  installed: true,
  registered: true,
  connected: true,
  // Daily settings do not imply that authentication or a model request passed.
  onboardingComplete: true,
  models: ["示例模型"],
  model: "示例模型",
  authMethods: [terminal, device],
  serviceCapabilities: { status: "unknown", formats: [] },
  apiFormats: [],
});
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-access-render-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Authentication = (await server.ssrLoadModule("/src/SetupAuthentication.jsx"))
    .default;
  Setup = (await server.ssrLoadModule("/src/AgentSetup.jsx")).default;
});
after(async () => {
  await server?.close();
});
const render = (item) =>
  renderToStaticMarkup(
    React.createElement(Authentication, { agent: item, onChange() {} }),
  );

test("account protection identifies each affected conversation without preventing registration preparation", () => {
  const method = {
    ...terminal,
    accountLabel: "示例账号",
    registration: { demo: true },
  };
  const html = renderToStaticMarkup(
    React.createElement(Authentication, {
      agent: { ...agent, authMethods: [method] },
      busyCount: 2,
      blockingTasks: [
        { id: "approval", title: "等待确认的网站修改", status: "approval" },
        { id: "unknown", title: "需要确认结果的工作", status: "unknown" },
      ],
      onOpenBlockingTask() {},
      onChange() {},
    }),
  );
  assert.ok(html.includes("等待确认的网站修改"));
  assert.ok(html.includes("需要确认结果的工作"));
  assert.ok(html.includes("审批待处理"));
  assert.ok(html.includes("结果未知"));
  assert.equal((html.match(/查看此工作/g) || []).length, 2);
  const registration = html.match(
    /<button[^>]*>没有账号？创建账号<\/button>/,
  )?.[0];
  assert.ok(registration && !registration.includes('disabled=""'));
  const login = html.match(/<button[^>]*>[^]*?登录 示例账号<\/button>/)?.[0];
  assert.ok(login?.includes('disabled=""'));
});

test("an unadmitted send describes why it cannot be opened and never invents a conversation link", () => {
  const html = renderToStaticMarkup(
    React.createElement(Authentication, {
      agent,
      busyCount: 1,
      blockingTasks: [
        {
          id: "pending",
          title: "正在发送的新对话",
          status: "submitting",
          canOpen: false,
        },
      ],
      onOpenBlockingTask() {},
      onChange() {},
    }),
  );
  assert.ok(html.includes("正在发送的新对话"));
  assert.ok(html.includes("等待发送结果"));
  assert.ok(!html.includes("查看此工作"));
});

test("registration can be prepared during protected work but continuing login remains protected", () => {
  const method = {
    ...terminal,
    accountLabel: "示例账号",
    registration: { demo: true },
  };
  const html = renderToStaticMarkup(
    React.createElement(Authentication, {
      agent: {
        ...agent,
        authMethods: [method],
        registration: {
          kind: "account",
          methodId: method.id,
          open: true,
          status: "waiting",
          page: "current",
          selection: {},
        },
      },
      busyCount: 1,
      blockingTasks: [
        { id: "approval", title: "待确认的工作", status: "approval" },
      ],
      onOpenBlockingTask() {},
      onChange() {},
    }),
  );
  assert.ok(html.includes("待确认的工作"));
  assert.ok(html.includes("查看此工作"));
  assert.match(
    html,
    /<button[^>]*disabled=""[^>]*>我已注册，继续登录<\/button>/,
  );
});

test("terminal authentication previews the official program boundary without inventing provider choices or accepting secrets", () => {
  const html = render(
    startAgentJob(agent, "auth", { authMethod: terminal }, 1000),
  );
  assert.ok(html.includes("官方流程预览 · 不执行真实登录"));
  assert.ok(html.includes('aria-label="官方登录交接"'));
  assert.ok(html.includes("打开服务设置"));
  assert.ok(!html.includes("演示订阅账号"));
  assert.ok(!html.includes("演示 API 服务"));
  assert.ok(!html.includes("<input"));
  assert.ok(!html.includes("<textarea"));
  assert.ok(!html.includes("<select"));
  assert.ok(!html.includes("已收到授权结果"));
  assert.ok(!html.includes("返回并检查</button>"));
});

test("a declared terminal account keeps that account without showing unrelated services or premature success", () => {
  const method = { ...terminal, accountLabel: "已选择的账号 A" };
  const html = render(
    startAgentJob(
      { ...agent, authMethods: [method, device] },
      "auth",
      { authMethod: method },
      1000,
    ),
  );
  assert.ok(html.includes("已选择的账号 A"));
  assert.ok(html.includes("打开登录页</button>"));
  assert.ok(!html.includes("演示订阅账号"));
  assert.ok(!html.includes("打开服务设置</button>"));
  assert.ok(!html.includes("已收到授权结果"));
  assert.ok(!html.includes("已完成登录授权"));
});
test("device authentication identifies the same pending operation and explains its deadline", () => {
  const html = render(
    startAgentJob(agent, "auth", { authMethod: device }, 1000),
  );
  assert.ok(html.includes("DEMO-ONLY"));
  assert.ok(html.includes("演示有效期：5 分钟"));
  assert.ok(html.includes("设备码授权"));
  assert.ok(!html.includes("<select"));
});
test("login cannot start before the program is added and connected", () => {
  for (const item of [
    { ...agent, installed: false, registered: false },
    { ...agent, connected: false },
  ]) {
    const html = render(item);
    const starts =
      html.match(/<button[^>]*class="agent-auth-method"[^>]*>/g) || [];
    assert.equal(starts.length, 2);
    assert.ok(starts.every((button) => button.includes('disabled=""')));
    assert.match(html, /先(?:添加|连接)/);
  }
});
test("unknown methods expose setup and reuse actions without inventing a purchase or login link", () => {
  const html = render({ ...agent, authMethods: [] });
  assert.ok(html.includes("打开登录设置"));
  assert.ok(!html.includes("使用已有设置"));
  assert.ok(!html.includes("登录账号"));
  assert.ok(!html.includes("href="));
});
test("source choices appear for supported API delivery or an existing API draft, without an unavailable default dead end", () => {
  const renderSetup = (item) =>
    renderToStaticMarkup(
      React.createElement(Setup, {
        initialContext: { view: "agents", intent: "manage" },
        agent: item,
        services: [],
        onChange() {},
        onClose() {},
        onUse() {},
      }),
    );
  const unavailable = renderSetup(agent);
  assert.equal((unavailable.match(/type="radio"/g) || []).length, 0);
  assert.ok(!unavailable.includes("<strong>API 服务</strong>"));
  const supported = renderSetup({
    ...agent,
    serviceCapabilities: { status: "implemented", formats: ["responses"] },
    apiFormats: ["responses"],
  });
  assert.equal((supported.match(/type="radio"/g) || []).length, 2);
  assert.ok(supported.includes("沿用已有设置"));
  assert.ok(supported.includes("API 服务"));
  const stale = renderSetup({
    ...agent,
    setupDraft: { access: "api", serviceId: "old", model: "M" },
  });
  assert.equal((stale.match(/type="radio"/g) || []).length, 2);
  assert.match(stale, /当前不可用，请切换到 Agent 配置/);
  assert.match(stale, /<input[^>]*type="radio"[^>]*disabled=""/);
});
test("explicit API authentication errors offer editing that service, never another Agent login", () => {
  const service = {
    id: "one",
    name: "API",
    format: "responses",
    endpoint: "https://a.example",
    models: ["model"],
    demoKey: true,
    secretRevision: 2,
  };
  const item = {
    ...agent,
    serviceCapabilities: { status: "implemented", formats: ["responses"] },
    apiFormats: ["responses"],
    setupDraft: { access: "api", serviceId: "one", model: "model" },
    serviceAuthIssues: [{ serviceId: "one", secretRevision: 2 }],
  };
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: item,
      services: [service],
      onChange() {},
      onClose() {},
      onUse() {},
    }),
  );
  assert.ok(html.includes("编辑此服务"));
  assert.ok(!html.includes("认证与账号帮助"));
  assert.ok(!html.includes("登录账号"));
});

test("a pending conversation does not disable the independent preparation test button", () => {
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent,
      services: [],
      busyCount: 1,
      onChange() {},
      onClose() {},
      onUse() {},
    }),
  );
  const testButton = html.match(/<button[^>]*>测试当前选择<\/button>/)?.[0];
  assert.ok(testButton, "preparation test button exists");
  assert.ok(!testButton.includes('disabled=""'));
});
test("a contextual repair opens its specific settings tab with the originating reason", () => {
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: {
        view: "thread",
        intent: "manage",
        panel: "model",
        reason: "继续聊聊首页的设计：请核对原模型与思考选择。",
      },
      agent,
      services: [],
      onChange() {},
      onClose() {},
    }),
  );
  assert.match(html, /id="setup-panel-model"[^>]*>/);
  assert.ok(!html.match(/id="setup-panel-model"[^>]*>/)[0].includes("hidden"));
  assert.ok(html.match(/id="setup-panel-account"[^>]*>/)[0].includes("hidden"));
  assert.ok(html.includes("继续聊聊首页的设计：请核对原模型与思考选择。"));
});
test("a declared API account prerequisite shows the same Agent login UI without replacing the selected service", () => {
  const service = {
    id: "api-account",
    name: "Account-required API",
    endpoint: "https://a.example",
    format: "responses",
    models: ["M"],
    demoKey: true,
  };
  const item = {
    ...agent,
    authRequired: true,
    serviceCapabilities: {
      status: "implemented",
      formats: ["responses"],
      requiresAgentAuthentication: true,
    },
    setupDraft: { access: "api", serviceId: service.id, model: "M" },
  };
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: item,
      services: [service],
      onChange() {},
      onClose() {},
    }),
  );
  assert.ok(html.includes('aria-label="账号操作"'));
  assert.ok(html.includes("登录账号"));
  assert.match(html, /<option value="api-account" selected="">/);
});
test("preparation opened from a matching draft retains source, model and reasoning selection", () => {
  const item = {
    ...agent,
    model: "Agent default",
    models: ["Agent default", "draft model"],
    efforts: ["Low", "High"],
    configOptions: [
      { id: "effort", label: "推理等级", options: ["Low", "High"] },
    ],
    serviceCapabilities: { status: "implemented", formats: ["responses"] },
    apiFormats: ["responses"],
  };
  const service = {
    id: "draft-service",
    name: "Draft API",
    endpoint: "https://a.example",
    format: "responses",
    models: ["draft model"],
    demoKey: true,
  };
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: item,
      services: [service],
      initialSelection: {
        agent: item.name,
        accessMode: "api",
        serviceId: service.id,
        model: "draft model",
        effort: "High",
      },
      onChange() {},
      onClose() {},
      onUse() {},
    }),
  );
  assert.match(html, /<option value="draft-service" selected="">/);
  assert.match(html, /<option value="draft model" selected="">/);
  assert.match(html, /<option value="High" selected="">/);
  const empty = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: item,
      services: [],
      initialSelection: {
        agent: item.name,
        accessMode: "existing",
        model: "",
        effort: "High",
      },
      onChange() {},
      onClose() {},
      onUse() {},
    }),
  );
  assert.match(empty, /<option value="" selected="">/);
  const other = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: item,
      services: [],
      initialSelection: {
        agent: "another Agent",
        model: "draft model",
        effort: "High",
      },
      onChange() {},
      onClose() {},
      onUse() {},
    }),
  );
  assert.match(other, /<option value="Agent default" selected="">/);
  assert.match(other, /<option value="Low" selected="">/);
});

test("return from registration keeps the selected account method and does not reuse another method's completion", () => {
  const a = {
    ...device,
    id: "a",
    accountLabel: "账号 A",
    registration: { demo: true },
  };
  const b = {
    ...device,
    id: "b",
    accountLabel: "账号 B",
    registration: { demo: true },
  };
  const item = {
    ...agent,
    authMethods: [a, b],
    authMethodSelection: "b",
    authentication: { status: "flow-finished", method: "a", folder: "" },
    registration: {
      kind: "account",
      methodId: "b",
      status: "registered",
      open: false,
      accountLabel: "账号 B",
      selection: {},
    },
  };
  const html = render(item);
  assert.match(html, /data-method-id="b" data-selected="true"/);
  assert.ok(!html.includes("注册与登录流程已结束"));
  assert.ok(html.includes("登录账号 · 账号 B"));
  assert.ok(!html.includes("重新登录</button>"));
});

test("browser authorization exposes a normal page action and keeps simulated receipts in folded review tools", () => {
  const browser = {
    id: "browser",
    type: "agent",
    presentation: "browser",
    label: "浏览器登录",
  };
  const html = render(
    startAgentJob(
      { ...agent, authMethods: [browser] },
      "auth",
      { authMethod: browser },
      1000,
    ),
  );
  assert.ok(html.includes("打开登录页"));
  assert.match(
    html,
    /<details class="onboarding-review-details"><summary>流程详情与演示结果/,
  );
  assert.ok(!html.includes('<details class="onboarding-review-details" open'));
  for (const method of [browser, device]) {
    const waiting = startAgentJob(
      { ...agent, authMethods: [method] },
      "auth",
      { authMethod: method },
      1000,
    );
    const page = render({
      ...waiting,
      accessJob: { ...waiting.accessJob, authPageOpen: true },
    }).split('<details class="onboarding-review-details">')[0];
    assert.match(page, /class="btn primary[^>]*>模拟同意授权<\/button>/);
    assert.ok(page.includes("返回 Farfold"));
    assert.equal(waiting.authentication, undefined);
    assert.equal(waiting.accessJob.status, "waiting");
  }
});

test("a removed saved login method does not silently select a different account", () => {
  const html = render({ ...agent, authMethodSelection: "removed" });
  assert.ok(html.includes("原登录方式不可用，请重新选择"));
  assert.ok(!html.includes('data-selected="true"'));
  assert.equal((html.match(/class="agent-auth-method"/g) || []).length, 2);
});

test("an observed Agent login error on an API choice exposes login even without a declared prerequisite", () => {
  const service = {
    id: "observed-api",
    name: "API",
    format: "responses",
    endpoint: "https://example.invalid",
    models: ["M"],
    demoKey: true,
  };
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: {
        ...agent,
        serviceCapabilities: { status: "implemented", formats: ["responses"] },
        setupDraft: {
          access: "api",
          serviceId: service.id,
          model: "M",
          folder: "",
        },
        authRequiredApiSelections: [JSON.stringify(["", service.id])],
      },
      services: [service],
      onChange() {},
      onClose() {},
    }),
  );
  assert.ok(html.includes("登录账号"));
  assert.ok(html.includes("需要完成登录后再使用"));
  assert.ok(!html.includes("编辑此服务"));
  assert.match(html, /<option value="observed-api" selected="">/);
});

test("account summary does not borrow a completed login from another working folder", () => {
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: {
        ...agent,
        authentication: {
          status: "flow-finished",
          folder: "/other",
          method: "terminal",
        },
      },
      initialContext: { view: "new", intent: "manage", folder: "/current" },
      onChange() {},
      onClose() {},
    }),
  );
  assert.ok(!html.includes("账号设置已更新，可返回使用"));
  assert.ok(html.includes("Agent 未提供身份信息"));
});

test("historical test result remains in the model panel and does not claim current success", () => {
  const html = renderToStaticMarkup(
    React.createElement(Setup, {
      initialContext: { view: "agents", intent: "manage" },
      agent: {
        ...agent,
        lastAccessResult: {
          type: "test",
          status: "passed",
          id: "old",
          message: "旧测试成功",
          fingerprint: "old-choice",
        },
      },
      onOpenTest() {},
      onChange() {},
      onClose() {},
    }),
  );
  const modelIndex = html.indexOf('<div id="setup-panel-model"');
  assert.ok(modelIndex > 0);
  assert.ok(!html.slice(0, modelIndex).includes("查看测试对话"));
  assert.ok(html.slice(modelIndex).includes("之前的测试记录不代表当前配置"));
  assert.ok(!html.includes("当前选择已通过测试"));
});
