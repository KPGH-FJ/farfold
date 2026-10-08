import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { normalizeAgent } from "../src/agent-setup-state.js";
import { beginRegistration } from "../src/registration-state.js";
import {
  startAgentJob,
  continueAgentJob,
  advanceAgentJobs,
} from "../src/access-jobs.js";
import {
  beginOfficialHandoff,
  transitionOfficialHandoff,
} from "../src/official-handoff-state.js";

let server, Setup, Authentication, Registration, Interaction, Handoff, Program;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-agent-access-unification-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Setup = (await server.ssrLoadModule("/src/AgentSetup.jsx")).default;
  Authentication = (await server.ssrLoadModule("/src/SetupAuthentication.jsx"))
    .default;
  Registration = (await server.ssrLoadModule("/src/AccountRegistration.jsx"))
    .default;
  Interaction = (
    await server.ssrLoadModule("/src/AuthenticationInteraction.jsx")
  ).default;
  Handoff = (await server.ssrLoadModule("/src/OfficialLoginHandoff.jsx"))
    .default;
  Program = (await server.ssrLoadModule("/src/access-program.jsx")).default;
});
after(async () => {
  await server?.close();
});
const method = {
  id: "declared",
  type: "agent",
  presentation: "browser",
  label: "账号授权",
  accountLabel: "示例账号",
  registration: { demo: true },
};
const route = {
  id: "documented",
  kind: "terminal",
  command: "sample",
  args: ["login"],
  label: "登录示例账号",
  actionLabel: "登录示例账号",
  accountOwner: "示例账号",
  purpose: "login",
  registration: { status: "not-reviewed" },
};
const base = normalizeAgent({
  id: "sample",
  name: "示例 Agent",
  installed: true,
  registered: true,
  connected: true,
  models: ["M"],
  model: "M",
});
const render = (Component, props) =>
  renderToStaticMarkup(React.createElement(Component, props));
const main = (html) => html.split('<details class="account-entry-details')[0];

test("single declared and documented login paths share direct actions; a missing selection still permits choosing a replacement", () => {
  for (const agent of [
    { ...base, authMethods: [method] },
    { ...base, authMethods: [], accountCapabilities: { routes: [route] } },
  ]) {
    const html = main(
      render(Authentication, { agent, onChange() {}, focused: true }),
    );
    assert.ok(
      !html.includes("<select"),
      "one method must not require a selector",
    );
    assert.ok(html.includes("没有账号？创建账号"));
  }
  const replaced = main(
    render(Authentication, {
      agent: { ...base, authMethods: [method], authMethodSelection: "removed" },
      onChange() {},
    }),
  );
  assert.ok(replaced.includes('class="agent-auth-method"'));
  assert.ok(replaced.includes("原登录方式不可用"));
});

test("both registration paths retain first-use progress and completed Agents keep daily management", () => {
  for (const agent of [
    {
      ...base,
      authMethods: [method],
      registration: beginRegistration({
        methodId: method.id,
        accountLabel: method.accountLabel,
      }),
    },
    {
      ...base,
      authMethods: [],
      accountCapabilities: { routes: [route] },
      registrationPortal: { open: true, routeId: route.id, page: "choose" },
    },
  ]) {
    const props = {
      agent,
      onChange() {},
      onClose() {},
      initialContext: { view: "new" },
    };
    const html = render(Setup, props);
    assert.ok(html.includes('aria-label="接入进度"'));
    assert.ok(html.includes("返回登录"));
    assert.equal((html.match(/role="dialog"/g) || []).length, 1);
    const management = render(Setup, {
      ...props,
      agent: { ...agent, onboardingComplete: true },
      initialContext: { view: "agents", intent: "manage" },
    });
    assert.ok(!management.includes('aria-label="接入进度"'));
    assert.ok(management.includes("返回登录"));
  }
});

test("an account-specific route with no verified signup URL returns to its login flow, never an unrelated service picker", () => {
  const html = render(Registration, {
    agent: base,
    route,
    onChange() {},
    onBack() {},
    onLogin() {},
  });
  assert.ok(html.includes("示例账号"));
  assert.ok(html.includes("打开登录页"));
  assert.ok(!html.includes("选择模型服务"));
  assert.ok(!html.includes("打开服务设置"));
  assert.ok(!html.includes("前往创建账号"));
});

test("browser and terminal account handoffs share one layout and returning never creates an approval", () => {
  for (const type of ["agent", "terminal"]) {
    const authMethod = { ...method, type };
    const flow = transitionOfficialHandoff(
      transitionOfficialHandoff(beginOfficialHandoff(null, authMethod), "open"),
      "return",
    );
    const html = render(Interaction, {
      job: { authMethod, officialHandoff: flow },
      onPageChange() {},
      onComplete() {},
      onFailure() {},
    });
    assert.ok(html.includes('aria-label="官方登录交接"'));
    assert.ok(html.includes("尚未收到完成结果"));
    assert.ok(html.includes("重新打开登录页"));
    assert.ok(!html.includes("已收到授权结果"));
    assert.ok(!html.includes("<input"));
  }
});

const elements = (value) =>
  value && typeof value === "object"
    ? [
        value,
        ...React.Children.toArray(value.props?.children).flatMap(elements),
      ]
    : [];
const text = (value) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : React.Children.toArray(value?.props?.children).map(text).join("");
const button = (tree, label) =>
  elements(tree).find(
    (node) => node.type?.name === "Button" && text(node) === label,
  );

test("the common handoff requires approval then result completion and preserves the pending model and folder", () => {
  for (const type of ["agent", "terminal"]) {
    const selection = {
      access: "existing",
      folder: "/original",
      model: "M",
      effort: "High",
    };
    const authMethod = { ...method, type };
    let current = startAgentJob(
      { ...base, authMethods: [authMethod] },
      "auth",
      { authMethod, selection },
    );
    const pending = structuredClone(current.accessJob.selection);
    const view = () =>
      Handoff({
        job: current.accessJob,
        onPageChange(changes) {
          current = {
            ...current,
            accessJob: { ...current.accessJob, ...changes },
          };
        },
        onComplete() {
          current = continueAgentJob(current, current.accessJob.id);
        },
        onFailure() {},
      });
    button(view(), "打开登录页").props.onClick();
    button(view(), "返回 Farfold").props.onClick();
    assert.equal(current.authentication, undefined);
    assert.equal(continueAgentJob(current, current.accessJob.id), current);
    button(view(), "重新打开登录页").props.onClick();
    button(view(), "模拟同意授权").props.onClick();
    assert.equal(current.authentication, undefined);
    button(view(), "继续").props.onClick();
    assert.equal(current.accessJob.status, "running");
    assert.deepEqual(current.accessJob.selection, pending);
    for (let count = 0; count < 3 && current.accessJob; count++)
      current = advanceAgentJobs([current], current.accessJob.dueAt + 1)[0];
    assert.equal(current.authentication.status, "flow-finished");
    assert.equal(current.authentication.folder, "/original");
    assert.equal(current.authentication.accountService, "示例账号");
  }
});

test("manual commands do not acquire official-page provenance from the shared handoff", () => {
  const html = render(Interaction, {
    job: {
      authMethod: {
        id: "manual",
        type: "terminal",
        manual: true,
        label: "自定义登录",
        command: "/chosen/program",
        purpose: "login",
      },
    },
    onPageChange() {},
    onComplete() {},
    onFailure() {},
  });
  assert.ok(!html.includes("官方"));
  assert.ok(html.includes("自定义登录"));
  assert.ok(html.includes("/chosen/program"));
});

test("unfinished work permits registration preparation while an active Agent operation prevents a second flow", () => {
  for (const agent of [
    { ...base, authMethods: [method] },
    { ...base, accountCapabilities: { routes: [route] } },
  ]) {
    const html = main(
      render(Authentication, { agent, onChange() {}, busyCount: 1 }),
    );
    const registration = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((value) => value.includes("没有账号？创建账号"));
    assert.ok(registration && !registration.includes('disabled=""'));
    const pendingOperation = {
      ...agent,
      accessJob: { id: "pending-check", type: "test", status: "running" },
    };
    const pendingHtml = main(
      render(Authentication, { agent: pendingOperation, onChange() {} }),
    );
    const pendingRegistration = [
      ...pendingHtml.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g),
    ]
      .map((match) => match[0])
      .find((value) => value.includes("没有账号？创建账号"));
    assert.ok(pendingRegistration?.includes('disabled=""'));
  }
  const declared = { ...base, authMethods: [method] };
  assert.equal(
    startAgentJob(declared, "auth", { authMethod: method, busyCount: 1 }),
    declared,
  );
  const activeLogin = startAgentJob(declared, "auth", { authMethod: method });
  assert.ok(activeLogin.accessJob);
  assert.ok(
    !render(Authentication, { agent: activeLogin, onChange() {} }).includes(
      "没有账号？创建账号",
    ),
  );
  assert.equal(
    startAgentJob(activeLogin, "auth", { authMethod: method }),
    activeLogin,
  );
});

test("multiple discovered programs require an explicit visible target while a single program stays one click away", () => {
  const installations = [
    { id: "first", path: "/old/agent", version: "1", managed: false },
    { id: "second", path: "/chosen/agent", version: "2", managed: false },
  ];
  const renderProgram = (items) =>
    render(Program, {
      agent: {
        ...base,
        connected: false,
        registered: false,
        selectedInstallationId: null,
        installations: items,
      },
      onChange() {},
    });
  const multiple = renderProgram(installations);
  assert.ok(multiple.includes("选择本机程序"));
  assert.ok(multiple.includes('value="" disabled="" selected=""'));
  assert.ok(multiple.includes("/old/agent"));
  assert.ok(multiple.includes("/chosen/agent"));
  const add = (html) =>
    [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((markup) => markup.includes("添加本机程序"));
  assert.ok(add(multiple).includes('disabled=""'));
  const single = renderProgram([installations[1]]);
  assert.ok(!single.includes("请选择一份程序"));
  assert.ok(!add(single).includes('disabled=""'));
});

test("managed unused versions expose independent cleanup while selected and external programs do not", () => {
  const installations = [
    { id: "selected", path: "/owned/current", managed: true, version: "2" },
    { id: "unused", path: "/owned/previous", managed: true, version: "1" },
    { id: "external", path: "/external", managed: false, version: "3" },
  ];
  const agent = {
    ...base,
    connected: true,
    registered: true,
    selectedInstallationId: "selected",
    installations,
  };
  const renderProgram = (changes = {}) =>
    render(Program, { agent, onChange() {}, ...changes });
  const cleanup = (html) =>
    [...html.matchAll(/<button[^>]*>卸载旧版本<\/button>/g)].map(
      (match) => match[0],
    );
  assert.equal(cleanup(renderProgram()).length, 1);
  assert.ok(!cleanup(renderProgram())[0].includes('disabled=""'));
  assert.ok(
    cleanup(renderProgram({ busyCount: 1 }))[0].includes('disabled=""'),
  );
  assert.ok(
    cleanup(
      renderProgram({
        allAgents: [
          { id: "other", registered: true, command: "/owned/previous/run" },
        ],
      }),
    )[0].includes('disabled=""'),
  );
  const blockedProgram = renderProgram({
    busyCount: 1,
    blockingTasks: [
      { id: "working", title: "未完成的工作", status: "running" },
    ],
  });
  assert.ok(blockedProgram.includes("程序管理前需要处理的工作"));
  assert.ok(blockedProgram.includes("先处理这些工作，再继续程序管理"));
  assert.ok(!blockedProgram.includes("再继续登录"));
  assert.ok(renderProgram().includes("移除 Agent"));
});
