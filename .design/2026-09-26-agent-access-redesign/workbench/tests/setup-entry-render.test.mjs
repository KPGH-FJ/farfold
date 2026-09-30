import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { normalizeAgent } from "../src/agent-setup-state.js";
import { draftForEntry } from "../src/setup-entry.js";
import { onboardingInitial } from "../src/onboarding-state.js";
let server, Setup, NewConversation;
const agent = normalizeAgent({
  id: "sample",
  name: "示例 Agent",
  installed: true,
  registered: true,
  connected: true,
  onboardingComplete: false,
  models: [],
  authMethods: [],
});
const prepared = { ...agent, onboardingComplete: true };
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-setup-entry-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Setup = (await server.ssrLoadModule("/src/AgentSetup.jsx")).default;
  NewConversation = (await server.ssrLoadModule("/src/NewConversationV2.jsx"))
    .default;
});
after(async () => {
  await server?.close();
});
const render = (overrides = {}) =>
  renderToStaticMarkup(
    React.createElement(Setup, {
      agent,
      onChange() {},
      onClose() {},
      ...overrides,
    }),
  );
const renderStep = (step, overrides = {}) => {
  const current = overrides.agent || agent;
  const context = overrides.initialContext || { view: "new", folder: "" };
  const draft = draftForEntry(
    current,
    overrides.services || [],
    overrides.initialSelection,
    context,
  );
  return render({
    ...overrides,
    initialContext: context,
    agent: {
      ...current,
      onboarding: {
        ...onboardingInitial(current, draft, context),
        step,
        intent: draft.access === "api" ? "api" : "existing",
      },
    },
  });
};
const finish = (html) => html.match(/<button[^>]*>进入对话<\/button>/)?.[0];
test("connected Agent with unknown auth can finish the review step without a mandatory paid short test", () => {
  const html = renderStep("review");
  const button = finish(html);
  assert.ok(button && !button.includes("disabled"));
  assert.ok(html.includes("尚未验证模型请求"));
  assert.ok(!html.includes("登录账号</button>"));
});
test("a program that has not connected cannot finish or skip ahead to account choices", () => {
  const html = render({
    agent: { ...agent, connected: false, connectionState: "idle" },
  });
  assert.ok(!finish(html));
  assert.ok(!html.includes('aria-label="选择使用方式"'));
  assert.ok(html.includes("连接 示例 Agent"));
});
test("preparation of an established conversation makes source selection read only", () => {
  const html = render({
    agent: {
      ...agent,
      serviceCapabilities: { status: "implemented", formats: ["responses"] },
    },
    initialContext: { view: "thread", active: "task-a", folder: "/A" },
    initialSelection: {
      agentId: "sample",
      agent: "示例 Agent",
      accessMode: "existing",
      model: "",
    },
  });
  const existing = html.match(/<input[^>]*type="radio"[^>]*>/)?.[0];
  assert.ok(existing.includes("disabled"));
  assert.ok(html.includes("此对话的来源与模型保持不变"));
});

test("global management saves settings without presenting a draft-use action", () => {
  for (const view of ["agents", "explore"]) {
    for (const intent of [undefined, "manage"]) {
      const html = render({
        agent: prepared,
        initialContext: { view, intent, folder: "" },
      });
      assert.match(html, /<button[^>]*>保存设置<\/button>/);
      assert.ok(!html.includes("开始新对话</button>"));
      assert.ok(!html.includes("使用此配置</button>"));
      assert.ok(!html.includes("返回已有对话</button>"));
      assert.ok(!html.includes("完成后返回草稿"));
    }
  }
});

test("explicit use from discovery starts the ordered guide and only offers draft entry in its review step", () => {
  for (const view of ["agents", "explore"]) {
    const context = { view, intent: "use", folder: "" };
    const initial = render({ initialContext: context });
    assert.ok(initial.includes('aria-label="选择使用方式"'));
    assert.ok(initial.includes('aria-label="接入进度"'));
    assert.ok(!initial.includes("保存设置</button>"));
    assert.ok(!finish(initial));
    const reviewed = renderStep("review", { initialContext: context });
    const button = finish(reviewed);
    assert.ok(button && !button.includes("disabled"));
    assert.ok(!reviewed.includes("保存设置</button>"));
    assert.ok(!reviewed.includes("发送</button>"));
  }
});

test("import preparation returns to existing conversations without offering to apply a new draft", () => {
  const context = { view: "agents", intent: "import", folder: "" };
  const html = render({ initialContext: context });
  const button = html.match(/<button[^>]*>返回已有对话<\/button>/)?.[0];
  assert.ok(button && !button.includes("disabled"));
  assert.ok(!html.includes("保存设置</button>"));
  assert.ok(!html.includes("使用此配置</button>"));
  const disconnected = render({
    initialContext: context,
    agent: { ...agent, connected: false, connectionState: "idle" },
  });
  assert.match(
    disconnected,
    /<button[^>]*disabled=""[^>]*>返回已有对话<\/button>/,
  );
  assert.match(disconnected, /<button[^>]*>暂时返回<\/button>/);
});

test("management entered from a draft still saves settings instead of applying its selection", () => {
  const html = render({
    agent: prepared,
    initialContext: { view: "new", intent: "manage", folder: "/A" },
  });
  assert.match(html, /<button[^>]*>保存设置<\/button>/);
  assert.ok(!html.includes("使用此配置</button>"));
  assert.ok(!html.includes("返回已有对话</button>"));
});

test("draft preparation first asks usage intent then returns to an editable unsent draft", () => {
  const initialContext = { view: "new", folder: "/A" };
  const html = render({ initialContext, returnLabel: "返回草稿" });
  assert.ok(html.includes('aria-label="选择使用方式"'));
  assert.match(html, /<button[^>]*>继续<\/button>/);
  const reviewed = renderStep("review", {
    initialContext,
    returnLabel: "返回草稿",
  });
  assert.ok(finish(reviewed));
  assert.ok(reviewed.includes("进入对话后，你可以编辑草稿再发送"));
  assert.ok(!reviewed.includes("发送</button>"));
  assert.ok(!reviewed.includes("保存设置</button>"));
});

test("existing conversation preparation preserves its source and returns to the original page", () => {
  const html = render({
    agent: {
      ...agent,
      serviceCapabilities: { status: "implemented", formats: ["responses"] },
    },
    initialContext: { view: "thread", active: "task-a", folder: "/A" },
    initialSelection: {
      agentId: "sample",
      agent: "示例 Agent",
      accessMode: "existing",
      model: "",
    },
    returnLabel: "返回原页面",
  });
  assert.match(html, /<button[^>]*>返回对话<\/button>/);
  assert.ok(html.includes("此对话的来源与模型保持不变"));
  assert.ok(!html.includes("完成后留在探索 Agent"));
  assert.ok(!html.includes("准备完成后回到草稿"));
});

test("a service authentication failure found in preparation exposes a direct repair action in the new draft", () => {
  const service = {
    id: "s",
    name: "测试服务",
    format: "responses",
    endpoint: "https://example.invalid",
    models: ["M"],
    secretRevision: 1,
  };
  const html = renderToStaticMarkup(
    React.createElement(NewConversation, {
      draft: "保留",
      files: [],
      choice: {
        agent: "示例 Agent",
        accessMode: "api",
        serviceId: "s",
        model: "M",
      },
      agents: [
        {
          ...agent,
          serviceCapabilities: {
            status: "implemented",
            formats: ["responses"],
          },
          serviceAuthIssues: [{ serviceId: "s", secretRevision: 1 }],
        },
      ],
      services: [service],
      sendError: "此服务认证失败",
      apiAuthBlocked: false,
    }),
  );
  assert.ok(html.includes("更新 API 配置"));
});

test("first connected entry shows three ordered stages and no parallel management panels", () => {
  const html = render();
  assert.ok(html.includes('aria-label="接入进度"'));
  assert.ok(html.includes("连接程序"));
  assert.ok(html.includes("使用方式"));
  assert.ok(html.includes("确认使用"));
  assert.ok(html.includes("沿用这台电脑上的设置"));
  assert.ok(html.includes("登录账号"));
  assert.ok(!html.includes("setup-panel-account"));
  assert.ok(!html.includes("setup-tab-program"));
});
test("missing program opens program actions while subsequent choices are absent", () => {
  const html = render({
    agent: { ...agent, connected: false, registered: false, installed: false },
  });
  assert.ok(html.includes('aria-label="接入进度"'));
  assert.ok(html.includes('class="access-program"'));
  assert.ok(!html.includes('aria-label="选择使用方式"'));
  assert.ok(!html.includes('aria-label="账号操作"'));
  assert.ok(!html.includes("进入对话</button>"));
});
test("unsupported Farfold API is not offered as a selectable dead end in first use", () => {
  const html = render();
  assert.ok(!html.includes("<strong>使用 API 配置</strong>"));
  assert.ok(html.includes('aria-label="选择使用方式"'));
});
test("completed Agent management preserves its account, model and program tabs", () => {
  const html = render({
    agent: prepared,
    initialContext: { view: "agents", intent: "manage" },
  });
  assert.match(html, /id="setup-tab-account"[^>]*aria-selected="true"/);
  assert.match(html, /id="setup-panel-program"[^>]*hidden/);
  assert.match(html, /id="setup-panel-model"[^>]*hidden/);
  assert.ok(!html.includes('aria-label="接入进度"'));
});
test("a matching API draft starts with API selected instead of silently replacing it with local settings", () => {
  const service = {
    id: "original-api",
    name: "原 API",
    endpoint: "https://a.example.invalid",
    format: "responses",
    models: ["M"],
  };
  const html = render({
    agent: {
      ...agent,
      serviceCapabilities: { status: "implemented", formats: ["responses"] },
    },
    services: [service],
    initialContext: { view: "new", folder: "/A" },
    initialSelection: {
      agentId: agent.id,
      accessMode: "api",
      serviceId: service.id,
      serviceSnapshot: service,
      model: "M",
    },
  });
  const selectedOption = [
    ...html.matchAll(
      /<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/g,
    ),
  ].map((match) => match[0]);
  assert.equal(selectedOption.length, 1);
  assert.ok(selectedOption[0].includes("使用 API 配置"));
});
test("review summary does not borrow an account service from a different folder or an unfinished login", () => {
  for (const authentication of [
    {
      status: "flow-finished",
      folder: "/other",
      accountService: "其他位置账号",
    },
    { status: "unknown", folder: "/A", accountService: "未知账号" },
  ]) {
    const html = renderStep("review", {
      agent: { ...agent, authentication },
      initialContext: { view: "new", folder: "/A" },
    });
    assert.ok(!html.includes(authentication.accountService));
    assert.ok(html.includes("Agent 在这台电脑上的设置"));
  }
});
test("an API draft whose delivery capability disappeared requires an explicit new choice instead of silently falling back", () => {
  const service = {
    id: "original-api",
    name: "原 API",
    endpoint: "https://a.example.invalid",
    format: "responses",
    models: ["M"],
  };
  const html = render({
    services: [service],
    initialContext: { view: "new", folder: "/A" },
    initialSelection: {
      agentId: agent.id,
      accessMode: "api",
      serviceId: service.id,
      serviceSnapshot: service,
      model: "M",
    },
  });
  assert.ok(!html.includes('aria-pressed="true"'));
  const proceed = html.match(/<button[^>]*>继续<\/button>/)?.[0];
  assert.ok(proceed?.includes("disabled"));
  assert.ok(!finish(html));
});
