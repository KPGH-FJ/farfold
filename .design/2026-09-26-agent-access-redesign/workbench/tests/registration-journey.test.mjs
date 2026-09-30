import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import {
  beginRegistration,
  registrationTransition,
} from "../src/registration-state.js";

let server, RegistrationJourney;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    cacheDir: "/tmp/farfold-registration-render-cache",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  RegistrationJourney = (
    await server.ssrLoadModule("/src/RegistrationJourney.jsx")
  ).default;
});
after(async () => {
  await server?.close();
});

const start = (overrides = {}) =>
  beginRegistration({
    accountLabel: "示例账号",
    methodId: "browser",
    selection: { folder: "/original", access: "existing", model: "chosen" },
    ...overrides,
  });
const render = (state, props = {}) =>
  renderToStaticMarkup(
    React.createElement(RegistrationJourney, {
      state,
      onChange() {},
      ...props,
    }),
  );
const content = (node) => {
  if (Array.isArray(node)) return node.map(content).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node?.props ? content(node.props.children) : "";
};
const find = (node, label) => {
  if (Array.isArray(node))
    return node.map((child) => find(child, label)).find(Boolean);
  if (!node?.props) return null;
  if (typeof node.props.onClick === "function" && content(node) === label)
    return node;
  return find(node.props.children, label);
};
function view(state, props = {}) {
  return RegistrationJourney({ state, onChange() {}, ...props });
}

test("registration needs an explicit launch; returning and leaving preserve the target without claiming success", () => {
  const selection = {
    folder: "/original",
    access: "existing",
    model: "chosen",
  };
  const destination = { label: "官方注册页面", verified: false };
  let state = start({ selection, destination });
  selection.model = "other";
  destination.label = "other";
  assert.equal(state.status, "ready");
  assert.equal(registrationTransition(state, "registered"), state);
  assert.equal(registrationTransition(state, "fail"), state);
  state = registrationTransition(state, "start");
  assert.equal(state.status, "waiting");
  assert.equal(state.page, "external");
  state = registrationTransition(state, "return-page");
  assert.equal(state.status, "waiting");
  state = registrationTransition(
    registrationTransition(state, "return"),
    "resume",
  );
  assert.equal(state.open, true);
  assert.equal(state.page, "farfold");
  assert.equal(state.selection.model, "chosen");
  assert.equal(state.destination.label, "官方注册页面");
  state = registrationTransition(
    registrationTransition(state, "fail"),
    "retry",
  );
  assert.equal(state.attempt, 2);
  assert.equal(state.status, "waiting");
  for (const field of ["authentication", "demoKey", "entitlement"])
    assert.equal(state[field], undefined);
});

test("primary launch and return actions expose an external placeholder, while simulation controls stay folded", () => {
  let state = start();
  let tree = view(state, {
    onChange(next) {
      state = next;
    },
  });
  find(tree, "查看注册步骤").props.onClick();
  assert.equal(state.page, "external");
  let html = render(state);
  assert.match(html, /外部步骤 · 未打开真实网站/);
  assert.doesNotMatch(html, /<(?:input|textarea|a)\b/);
  const review = html.match(
    /<details class="registration-review">([\s\S]*)<\/details>/,
  )?.[1];
  assert.ok(review?.includes("模拟注册完成"));
  assert.ok(review?.includes("模拟注册未完成"));
  assert.doesNotMatch(
    html.split('<details class="registration-review">')[0],
    /模拟注册完成|模拟注册未完成/,
  );
  tree = view(state, {
    onChange(next) {
      state = next;
    },
  });
  find(tree, "返回 Farfold").props.onClick();
  assert.equal(state.status, "waiting");
  assert.equal(state.page, "farfold");
  html = render(state);
  assert.match(html, /注册结果待确认/);
  assert.match(html, /我已注册，继续登录/);
});

test("self-reported registration continues the exact pending account without manufacturing an official completion", () => {
  const state = registrationTransition(
    registrationTransition(start(), "start"),
    "return-page",
  );
  let handedOff,
    changed = false;
  const tree = view(state, {
    onContinue(next) {
      handedOff = next;
    },
    onChange() {
      changed = true;
    },
  });
  find(tree, "我已注册，继续登录").props.onClick();
  assert.equal(changed, false);
  assert.equal(handedOff.status, "waiting");
  assert.equal(handedOff.open, false);
  assert.equal(handedOff.methodId, state.methodId);
  assert.deepEqual(handedOff.selection, state.selection);
  assert.equal(handedOff.authentication, undefined);
});

test("existing accounts skip registration and immediately hand off to the selected login method", () => {
  let next;
  const tree = view(start(), {
    onContinue(value) {
      next = value;
    },
  });
  find(tree, "已有账号，继续登录").props.onClick();
  assert.equal(next.existingAccount, true);
  assert.equal(next.open, false);
  assert.equal(next.attempt, 0);
  assert.equal(next.methodId, "browser");
  assert.equal(next.authentication, undefined);
});

test("a login blocker disables every login handoff, but allows return with all selections preserved", () => {
  const states = [
    start(),
    registrationTransition(
      registrationTransition(start(), "start"),
      "return-page",
    ),
    registrationTransition(
      registrationTransition(start(), "start"),
      "registered",
    ),
  ];
  for (const state of states) {
    const current = { ...state, page: "farfold" };
    let continued = false,
      returned;
    const props = {
      continueIssue: "原登录方式已不可用。",
      onContinue() {
        continued = true;
      },
      onChange(next) {
        returned = next;
      },
    };
    const tree = view(current, props);
    const label =
      current.status === "ready"
        ? "已有账号，继续登录"
        : current.status === "waiting"
          ? "我已注册，继续登录"
          : "继续登录";
    const action = find(tree, label);
    assert.equal(action.props.disabled, true);
    action.props.onClick();
    assert.equal(continued, false);
    find(tree, "返回准备页").props.onClick();
    assert.equal(returned.open, false);
    assert.deepEqual(returned.selection, current.selection);
    assert.match(render(current, props), /继续登录前：原登录方式已不可用/);
  }
});

test("without a login callback, continuing only closes registration and never creates authentication state", () => {
  const state = registrationTransition(
    registrationTransition(start(), "start"),
    "registered",
  );
  let next;
  const tree = view(
    { ...state, page: "farfold" },
    {
      onChange(value) {
        next = value;
      },
    },
  );
  find(tree, "继续登录").props.onClick();
  assert.equal(next.open, false);
  assert.equal(next.status, "registered");
  assert.equal(next.authentication, undefined);
});

test("a matching completed login returns to preparation without rewriting registration or asking for another login", () => {
  const waiting = registrationTransition(start(), "start");
  for (const state of [
    start(),
    waiting,
    registrationTransition(waiting, "registered"),
  ]) {
    let returned,
      continued = false;
    const props = {
      loginFinished: true,
      continueIssue: "This old blocker must not request another login.",
      onContinue() {
        continued = true;
      },
      onChange(next) {
        returned = next;
      },
    };
    const html = render(state, props);
    assert.match(html, /登录步骤已完成，可返回准备页继续/);
    assert.match(html, /模型是否可用，仍由后续实际请求确认/);
    assert.doesNotMatch(
      html,
      /继续登录|前往官方注册|注册结果待确认|old blocker|模拟注册完成/,
    );
    const action = find(view(state, props), "返回准备页");
    assert.equal(action.props.primary, true);
    action.props.onClick();
    assert.equal(continued, false);
    assert.equal(returned.open, false);
    assert.equal(returned.status, state.status);
    assert.deepEqual(returned.selection, state.selection);
    assert.equal(returned.authentication, undefined);
  }
});

test("a login completion prop cannot skip API registration or key acquisition", () => {
  const state = start({
    kind: "api",
    destination: { verified: true, url: "https://official.example/register" },
  });
  const html = render(state, { loginFinished: true });
  assert.match(html, /前往官方注册/);
  assert.match(html, /已有账号，获取密钥/);
  assert.doesNotMatch(html, /登录步骤已完成，可返回准备页继续/);
});

test("API with a verified destination keeps key acquisition separate and never stores or distributes a key", () => {
  let state = start({
    kind: "api",
    destination: { verified: true, url: "https://official.example/register" },
    selection: {
      provider: "Example",
      endpoint: "https://api.example/v1",
      format: "responses",
    },
  });
  assert.equal(registrationTransition(state, "key-issued"), state);
  find(
    view(state, {
      onChange(next) {
        state = next;
      },
    }),
    "已有账号，获取密钥",
  ).props.onClick();
  assert.equal(state.existingAccount, true);
  let html = render(state);
  assert.match(html, /打开服务商页面/);
  assert.match(
    html,
    /<details class="registration-review">[\s\S]*模拟已获取密钥/,
  );
  assert.doesNotMatch(
    html.split('<details class="registration-review">')[0],
    /模拟已获取密钥/,
  );
  find(
    view(state, {
      onChange(next) {
        state = next;
      },
    }),
    "模拟已获取密钥",
  ).props.onClick();
  find(
    view(state, {
      onChange(next) {
        state = next;
      },
    }),
    "返回填写 API 配置",
  ).props.onClick();
  assert.equal(state.open, false);
  assert.equal(state.demoKey, undefined);
  assert.equal(state.credentials, undefined);
  assert.equal(state.entitlement, undefined);
  assert.equal(state.selection.endpoint, "https://api.example/v1");
});

test("destination metadata is informational only; unknown or unsafe addresses are never exposed", () => {
  assert.match(render(start()), /注册入口尚未核实/);
  for (const destination of [
    { url: "https://not-verified.example", verified: false },
    { url: "https://user:secret@unsafe.example", verified: true },
    { url: "https://unsafe.example/?token=secret", verified: true },
    { url: "javascript:alert(1)", verified: true },
  ]) {
    const html = render(start({ destination }));
    assert.doesNotMatch(
      html,
      /not-verified\.example|unsafe\.example|javascript:|href=/,
    );
  }
  const html = render(
    start({
      destination: {
        label: "示例官方页面",
        url: "https://official.example/register",
        verified: true,
      },
    }),
  );
  assert.match(html, /https:\/\/official\.example\/register/);
  assert.doesNotMatch(html, /href=/);
});

test("an arbitrary API provider cannot become an official signup destination or a simulated credential receipt", () => {
  const state = start({
    kind: "api",
    accountLabel: "示例服务",
    selection: {
      name: "未保存配置",
      endpoint: "https://models.example.invalid/v1",
      format: "responses",
    },
  });
  for (const status of ["ready", "waiting", "registered", "key-issued"]) {
    const current = { ...state, status, page: "external" };
    const html = render(current, { loginFinished: true });
    assert.match(html, /示例服务/);
    assert.match(html, /返回填写 API 配置/);
    assert.doesNotMatch(
      html,
      /前往官方注册|官方页面流程占位|打开官方页面|打开服务商页面|注册步骤已完成|密钥获取步骤已完成|模拟已获取密钥|href=/,
    );
    let returned;
    find(
      view(current, {
        onChange(next) {
          returned = next;
        },
      }),
      "返回填写 API 配置",
    ).props.onClick();
    assert.equal(returned.open, false);
    assert.equal(returned.status, "ready");
    assert.equal(returned.page, "farfold");
    assert.deepEqual(returned.selection, state.selection);
    assert.equal(returned.authentication, undefined);
    assert.equal(returned.demoKey, undefined);
  }
});

test("unverified API registration has no external-page or success transition", () => {
  for (const destination of [
    undefined,
    { verified: false, url: "https://unverified.example.invalid" },
    { verified: true, url: "javascript:alert(1)" },
  ]) {
    const state = start({ kind: "api", destination });
    for (const action of [
      "start",
      "open-page",
      "registered",
      "existing-account",
      "key-issued",
      "retry",
    ]) {
      assert.equal(registrationTransition(state, action), state);
    }
    const stale = {
      ...state,
      status: "key-issued",
      page: "external",
      open: false,
    };
    const resumed = registrationTransition(stale, "resume");
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.page, "farfold");
    assert.equal(resumed.open, true);
    assert.deepEqual(resumed.selection, state.selection);
  }
});

test("an Agent registration sample without a verified URL remains a generic preview and does not claim a specific official page", () => {
  const state = start({
    destination: { verified: false, label: "未经核实的官方页面" },
  });
  const html = render(state);
  assert.doesNotMatch(html, /前往官方注册|未经核实的官方页面/);
  let opened;
  find(
    view(state, {
      onChange(next) {
        opened = next;
      },
    }),
    "查看注册步骤",
  ).props.onClick();
  assert.equal(opened.page, "external");
  assert.match(render(opened), /注册步骤预览/);
  assert.doesNotMatch(render(opened), /官方页面流程占位|未经核实的官方页面/);
  assert.equal(opened.methodId, state.methodId);
});
