import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let server, Registration;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-account-registration-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  Registration = (await server.ssrLoadModule("/src/AccountRegistration.jsx"))
    .default;
});
after(async () => {
  await server?.close();
});
const accountA = {
  id: "account-a",
  status: "verified-entry",
  owner: "服务 A",
  url: "https://a.example.invalid/signup",
};
const accountB = {
  id: "account-b",
  status: "verified-entry",
  owner: "服务 B",
  url: "https://b.example.invalid/create?source=official-help",
};
const agent = {
  id: "sample",
  authentication: { status: "unknown" },
  setupDraft: { model: "M", folder: "/A" },
};
const baseRoute = {
  id: "route-a",
  command: "sample",
  programLabel: "示例程序",
  sourceUrl: "https://docs.example.invalid/accounts",
};
const props = (changes = {}) => ({
  agent,
  route: { ...baseRoute, registration: accountA },
  onBack() {},
  onChange() {},
  onLogin() {},
  ...changes,
});
const render = (value) =>
  renderToStaticMarkup(React.createElement(Registration, value));
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
    (element) => element.type?.name === "Button" && text(element) === label,
  );

test("single verified registration preserves the selected route through preview and return without claiming account success", () => {
  let current = structuredClone(agent),
    loginCalls = 0;
  const view = () =>
    props({
      agent: current,
      onChange(next) {
        current = next;
      },
      onLogin() {
        loginCalls += 1;
      },
    });
  assert.match(render(view()), /服务 A账号/);
  button(Registration(view()), "前往创建账号").props.onClick();
  assert.deepEqual(current.registrationPortal, {
    open: true,
    routeId: "route-a",
    optionId: "account-a",
    page: "external",
  });
  const external = render(view());
  assert.match(external, /https:\/\/a\.example\.invalid\/signup/);
  assert.ok(!external.includes('href="https://a.example.invalid/signup"'));
  assert.ok(!external.includes("<input"));
  assert.ok(!external.includes("<iframe"));
  button(Registration(view()), "返回 Farfold").props.onClick();
  assert.equal(current.registrationPortal.page, "returned");
  assert.deepEqual(current.authentication, agent.authentication);
  assert.deepEqual(current.setupDraft, agent.setupDraft);
  assert.equal(current.registration, undefined);
  assert.equal(loginCalls, 0);
  assert.ok(!render(view()).includes("注册成功"));
  button(Registration(view()), "继续登录").props.onClick();
  assert.equal(loginCalls, 1);
  assert.equal(current.authentication.status, "unknown");
});

test("multiple verified account choices do not silently pick a service or manufacture a login provider", () => {
  let current = structuredClone(agent);
  const view = () =>
    props({
      agent: current,
      route: { ...baseRoute, registrationOptions: [accountA, accountB] },
      onChange(next) {
        current = next;
      },
    });
  const tree = Registration(view());
  assert.equal(button(tree, "前往创建账号").props.disabled, true);
  const option = elements(tree).find(
    (element) =>
      element.props?.["aria-pressed"] === false &&
      text(element).startsWith("服务 B"),
  );
  option.props.onClick();
  assert.equal(current.registrationPortal.optionId, "account-b");
  assert.equal(current.registrationPortal.page, "choose");
  assert.equal(current.authMethodSelection, undefined);
  button(Registration(view()), "前往创建账号").props.onClick();
  assert.match(render(view()), /b\.example\.invalid/);
  assert.ok(!render(view()).includes("a.example.invalid"));
});

test("unknown or invalid registration destination routes to service setup and does not invent a signup URL", () => {
  for (const registration of [
    { ...accountA, status: "unknown" },
    { ...accountA, url: "javascript:alert(1)" },
    { ...accountA, url: "https://secret@example.invalid/signup" },
  ]) {
    const value = props({ route: { ...baseRoute, registration } });
    const html = render(value);
    assert.match(html, /先在 示例程序 中选择模型服务/);
    assert.match(html, /打开服务设置/);
    assert.match(html, /官方账号说明/);
    assert.ok(!html.includes("前往创建账号"));
    assert.ok(!html.includes("a.example.invalid"));
    assert.ok(!html.includes("javascript:"));
  }
});

test("a previous route or removed account option cannot resume another registration preview", () => {
  for (const portal of [
    { routeId: "old-route", optionId: "account-a" },
    { routeId: "route-a", optionId: "removed-account" },
  ]) {
    const html = render(
      props({
        agent: {
          ...agent,
          registrationPortal: { ...portal, open: true, page: "returned" },
        },
      }),
    );
    assert.match(html, /前往创建账号/);
    assert.ok(!html.includes("重新打开注册页"));
    assert.ok(!html.includes("继续登录</button>"));
  }
});
