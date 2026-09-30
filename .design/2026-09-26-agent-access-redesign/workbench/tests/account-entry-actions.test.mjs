import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  accountCapabilities,
  ACCOUNT_CAPABILITIES,
} from "../src/account-capabilities.js";
import { manualAuthenticationMethod } from "../src/authentication-state.js";
import { confirmOfficialAccountProgram } from "../src/official-account-route.js";
import {
  beginOfficialHandoff,
  transitionOfficialHandoff,
} from "../src/official-handoff-state.js";

let server, Setup, startRoute, selectedRoute;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-account-entry-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const module = await server.ssrLoadModule("/src/SetupAuthentication.jsx");
  Setup = module.default;
  startRoute = module.startOfficialAccountRoute;
  selectedRoute = module.selectedOfficialAccountRoute;
});
after(async () => {
  await server?.close();
});
const agent = (id) => ({
  id,
  name: id,
  installed: true,
  registered: true,
  connected: true,
  connectionState: "connected",
  authMethods: [],
  models: ["chosen"],
  model: "chosen",
});
const selection = {
  folder: "/original",
  access: "existing",
  model: "chosen",
  effort: "High",
};
const render = (item, options = {}) =>
  renderToStaticMarkup(
    React.createElement(Setup, {
      agent: item,
      selection,
      onChange() {},
      ...options,
    }),
  );
const main = (html) => html.replace(/<details\b[\s\S]*?<\/details>/g, "");
const button = (html, label) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((markup) => markup.includes(label));

test("every documented Agent has a normal setup/login action without needing invented protocol methods", () => {
  for (const id of Object.keys(ACCOUNT_CAPABILITIES)) {
    const current = agent(id);
    const route = accountCapabilities(current).routes[0];
    const html = main(render(current));
    assert.ok(
      html.includes(route.actionLabel),
      `${id}: documented account action visible`,
    );
    assert.ok(button(html, route.actionLabel));
    assert.doesNotMatch(button(html, route.actionLabel), /class="btn primary/);
    assert.ok(
      html.includes("没有账号？"),
      `${id}: provider-dependent account acquisition has an explicit entry`,
    );
    assert.ok(!html.includes("使用已有设置"));
    assert.ok(!html.includes("已在外部完成设置，重新检查"));
    const required = main(render(current, { required: true }));
    assert.match(button(required, route.actionLabel), /class="btn primary/);
    assert.ok(required.includes("已在外部完成设置，重新检查"));
    assert.doesNotMatch(
      html,
      /尚未提供|还没有可用的认证动作|官方文档确认|手动配置登录/,
    );
    assert.deepEqual(current.authMethods, []);
  }
});

test("explicit route launch preserves the exact command and draft, keeps protocol methods empty, and claims no login", () => {
  for (const id of Object.keys(ACCOUNT_CAPABILITIES)) {
    const current = agent(id);
    for (const route of accountCapabilities(current).routes) {
      const next = startRoute(
        confirmOfficialAccountProgram(current, route.id),
        route.id,
        {
          selection,
          accountActionPurpose: "registration",
        },
      );
      assert.equal(next.accessJob.status, "waiting");
      assert.equal(next.accessJob.authMethod.command, route.command);
      assert.deepEqual(next.accessJob.authMethod.args, route.args);
      assert.deepEqual(next.accessJob.selection, selection);
      assert.equal(next.accountRouteSelection, route.id);
      assert.equal(next.accessJob.accountActionPurpose, "registration");
      assert.deepEqual(next.authMethods, []);
      assert.equal(next.registration, undefined);
      assert.equal(next.authentication, undefined);
      assert.equal(selectedRoute(next, next.accessJob.authMethod).id, route.id);
      const html = render(next);
      const visible = main(html);
      assert.ok(html.includes([route.command, ...route.args].join(" ")));
      if (route.purpose === "login") {
        assert.ok(visible.includes(route.accountOwner));
        assert.ok(button(visible, "打开登录页"));
        assert.ok(!visible.includes('aria-label="演示账号服务"'));
      } else {
        assert.ok(visible.includes('aria-label="官方登录交接"'));
        assert.ok(button(visible, "打开服务设置"));
        assert.ok(!visible.includes("演示订阅账号"));
        assert.ok(!visible.includes("演示 API 服务"));
      }
      assert.ok(!button(visible, "返回设置"));
      assert.ok(!visible.includes("已完成登录授权"));
      assert.doesNotMatch(visible, /不执行系统命令|不接收真实密码/);
    }
  }
});

test("busy or unprepared work cannot start a documented command, and an unknown route never falls back", () => {
  const current = confirmOfficialAccountProgram(
      agent("cline"),
      "cline-provider",
    ),
    route = accountCapabilities(current).routes[0];
  for (const [item, options] of [
    [current, { busyCount: 1 }],
    [{ ...current, installed: false }, {}],
    [{ ...current, connected: false }, {}],
    [
      {
        ...current,
        accessJob: { id: "pending", type: "auth", status: "unknown" },
      },
      {},
    ],
  ])
    assert.equal(startRoute(item, route.id, options), item);
  assert.equal(startRoute(current, "not-a-route"), current);
});

test("a manually typed lookalike command is not presented as an explicitly chosen official route", () => {
  const current = agent("claude-agent");
  const [first, second] = accountCapabilities(current).routes;
  const manual = manualAuthenticationMethod(
    first.command,
    first.args.join("\n"),
  );
  assert.equal(selectedRoute(current, manual), null);
  const manualHtml = render({
    ...current,
    manualAuthentication: manual,
    authMethodSelection: manual.id,
  });
  assert.ok(
    manualHtml.includes("其他官方登录方式"),
    "saved manual settings retain an explicit route back to official setup",
  );
  assert.ok(!main(manualHtml).includes("其他官方登录方式"));
  assert.match(manualHtml, /<details[^>]*account-entry-more[^>]*>/);
  assert.match(manualHtml, /自定义登录/);
  assert.equal(
    selectedRoute({ ...current, accountRouteSelection: second.id }, manual),
    null,
  );
  assert.equal(
    selectedRoute(
      { ...current, accountRouteSelection: first.id },
      { ...manual, args: ["different"] },
    ),
    null,
  );
  const chosen = startRoute(
    confirmOfficialAccountProgram(current, second.id),
    second.id,
    { selection },
  );
  const html = render({ ...chosen, accessJob: null });
  assert.match(html, /<option value="claude-console" selected="">/);
  assert.equal(
    selectedRoute(chosen, chosen.manualAuthentication).id,
    second.id,
  );
});

test("Qwen service setup stays separate from an account-login promise", () => {
  const current = agent("qwen-code"),
    route = accountCapabilities(current).routes[0];
  const html = main(render(current));
  assert.ok(html.includes("打开服务配置"));
  assert.doesNotMatch(html, /登录 Qwen 账号|Qwen 账号授权/);
  const next = startRoute(
    confirmOfficialAccountProgram(current, route.id),
    route.id,
    { selection },
  );
  const waiting = main(render(next));
  assert.ok(waiting.includes("在 qwen 中配置服务"));
  assert.ok(button(waiting, "打开服务设置"));
  assert.ok(!waiting.includes("演示订阅账号"));
  assert.ok(!waiting.includes("演示 API 服务"));
  assert.doesNotMatch(waiting, /登录 Qwen 账号|Qwen 账号授权|已完成设置/);
  assert.equal(next.accessJob.authMethod.command, route.command);
  const completed = main(
    render({
      ...next,
      accessJob: null,
      authentication: {
        status: "flow-finished",
        method: "manual-explicit",
        folder: selection.folder,
      },
    }),
  );
  assert.ok(completed.includes("已完成设置"));
  assert.ok(!completed.includes("登录步骤已完成"));
});

test("official account authorization requires its own confirmation while returning never completes login", () => {
  const current = agent("codex"),
    route = accountCapabilities(current).routes[0];
  const started = startRoute(
    confirmOfficialAccountProgram(current, route.id),
    route.id,
    { selection },
  );
  let flow = beginOfficialHandoff(route, started.accessJob.authMethod);
  const show = () =>
    main(
      render({
        ...started,
        accessJob: { ...started.accessJob, officialHandoff: flow },
      }),
    );
  assert.ok(button(show(), "打开登录页"));
  assert.ok(!button(show(), "模拟同意授权"));
  flow = transitionOfficialHandoff(flow, "open");
  assert.ok(button(show(), "模拟同意授权"));
  assert.ok(button(show(), "返回 Farfold"));
  flow = transitionOfficialHandoff(flow, "return");
  assert.ok(button(show(), "重新打开登录页"));
  assert.ok(!show().includes("已收到授权结果"));
  assert.ok(!button(show(), "继续</button>"));
  flow = transitionOfficialHandoff(flow, "open");
  flow = transitionOfficialHandoff(flow, "approve");
  assert.ok(show().includes("已收到授权结果"));
  assert.ok(button(show(), "继续</button>"));
  assert.ok(!show().includes("已完成登录授权"));
  assert.equal(started.authentication, undefined);
});

test("Agent-owned service setup is a handoff whose return does not fabricate provider choice, credentials or account approval", () => {
  const current = agent("cline"),
    route = accountCapabilities(current).routes[0];
  const started = startRoute(
    confirmOfficialAccountProgram(current, route.id),
    route.id,
    { selection },
  );
  let flow = beginOfficialHandoff(route, started.accessJob.authMethod);
  const show = () =>
    main(
      render({
        ...started,
        accessJob: { ...started.accessJob, officialHandoff: flow },
      }),
    );
  assert.ok(button(show(), "打开服务设置"));
  flow = transitionOfficialHandoff(flow, "open");
  assert.ok(button(show(), "模拟完成程序设置"));
  assert.ok(!button(show(), "模拟同意授权"));
  flow = transitionOfficialHandoff(flow, "return");
  assert.ok(button(show(), "继续服务设置"));
  assert.ok(!button(show(), "返回并检查"));
  flow = transitionOfficialHandoff(flow, "open");
  flow = transitionOfficialHandoff(flow, "settings-returned");
  assert.ok(button(show(), "返回并检查"));
  assert.ok(show().includes("设置步骤已返回"));
  assert.ok(!show().includes("已收到授权结果"));
  assert.ok(!show().includes("演示订阅账号"));
  assert.ok(!show().includes("演示 API 服务"));
  assert.doesNotMatch(show(), /<input|<textarea|type="password"/);
  assert.equal(started.authentication, undefined);
  assert.deepEqual(started.accessJob.selection, selection);
});

test("unknown capabilities retain manual setup without an unconditional reuse action or a forged external URL", () => {
  const current = agent("unknown");
  const html = render(current);
  assert.ok(main(html).includes("打开登录设置"));
  assert.ok(!main(html).includes("使用已有设置"));
  assert.ok(!main(html).includes("没有账号？"));
  assert.doesNotMatch(html, /href=/);
  assert.equal(startRoute(current, "anything"), current);
});

test("unconfirmed documented programs render preparation before any login operation", () => {
  const current = agent("claude-agent");
  const route = accountCapabilities(current).routes[0];
  const preparing = {
    ...current,
    accountPreparation: { open: true, routeId: route.id, purpose: "settings" },
  };
  const html = main(render(preparing));
  assert.match(html, /class="account-route-preparation"/);
  assert.ok(html.includes("准备登录"));
  assert.ok(html.includes("选择用于登录的本机程序"));
  assert.ok(html.includes(route.programLabel));
  assert.ok(button(html, "使用此程序并继续"));
  assert.ok(!html.includes("终端演示"));
  assert.ok(!html.includes("已完成设置"));
  assert.equal(preparing.accessJob, undefined);
  assert.equal(startRoute(preparing, route.id, { selection }), preparing);
});

test("provider-dependent account acquisition is a separate preparation step and does not claim registration", () => {
  const current = agent("qwen-code");
  const route = accountCapabilities(current).routes[0];
  const acquiring = {
    ...current,
    accountPreparation: {
      open: true,
      routeId: route.id,
      purpose: "registration",
    },
  };
  const html = main(render(acquiring));
  assert.ok(html.includes("准备登录程序"));
  assert.ok(html.includes("在接下来的官方流程中选择服务"));
  assert.ok(html.includes("前往该服务的注册入口，再回来继续登录"));
  assert.ok(button(html, "使用此程序并继续"));
  assert.ok(!html.includes("注册步骤已完成"));
  assert.equal(acquiring.registration, undefined);
  assert.equal(acquiring.authentication, undefined);
  assert.equal(acquiring.accessJob, undefined);
  const confirmedHtml = main(
    render(confirmOfficialAccountProgram(acquiring, route.id)),
  );
  assert.ok(confirmedHtml.includes("前往该服务的注册入口"));
  assert.ok(button(confirmedHtml, "继续官方流程"));
  const login = main(
    render({
      ...acquiring,
      accountPreparation: {
        ...acquiring.accountPreparation,
        purpose: "settings",
      },
    }),
  );
  assert.ok(!login.includes("前往该服务的注册入口"));
});

test("declared login remains optional until an explicit requirement, without changing the selected source", () => {
  const current = {
    ...agent("codex"),
    authMethods: [{ id: "browser", type: "agent", label: "账号授权" }],
  };
  const optional = main(render(current));
  assert.doesNotMatch(button(optional, "登录账号"), /class="btn primary/);
  assert.ok(!optional.includes("已在外部完成设置，重新检查"));
  const required = main(render(current, { required: true }));
  assert.match(button(required, "登录账号"), /class="btn primary/);
  assert.ok(required.includes("已在外部完成设置，重新检查"));
  assert.equal(selection.access, "existing");
  assert.equal(selection.model, "chosen");
});

test("a removed registration route cannot fall back to another account's signup or login", () => {
  const current = {
    ...agent("unknown"),
    accountCapabilities: {
      routes: [
        {
          id: "replacement",
          kind: "terminal",
          purpose: "login",
          command: "another-login",
          args: [],
          accountOwner: "新账号服务",
          registration: {
            id: "new-account",
            status: "verified-entry",
            owner: "新账号服务",
            url: "https://new.example.invalid/signup",
          },
        },
      ],
    },
    registrationPortal: {
      open: true,
      routeId: "removed-route",
      optionId: "original-account",
      page: "returned",
    },
  };
  const html = main(render(current));
  assert.ok(!html.includes("新账号服务"));
  assert.ok(!button(html, "前往创建账号"));
  assert.ok(!button(html, "打开服务设置"));
  assert.match(html, /返回登录|重新选择/);
  assert.equal(current.authentication, undefined);
  assert.equal(current.registrationPortal.routeId, "removed-route");
});
