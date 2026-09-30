import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CATALOG } from "../src/agent-catalog.js";
import {
  accountCapabilities,
  accountRoute,
} from "../src/account-capabilities.js";

const agent = (id) =>
  structuredClone(AGENT_CATALOG.find((item) => item.id === id));

test("an unread declaration is not treated as absence of documented account setup", () => {
  const cline = agent("cline");
  const before = structuredClone(cline);
  assert.deepEqual(cline.authMethods, []);
  const capabilities = accountCapabilities(cline);
  assert.equal(capabilities.localDeclaration, "not-read");
  assert.equal(capabilities.routes[0].kind, "terminal");
  assert.equal(capabilities.routes[0].command, "cline");
  assert.deepEqual(capabilities.routes[0].args, ["auth"]);
  assert.deepEqual(
    cline,
    before,
    "reading official routes cannot synthesize a protocol method or a login result",
  );
});

test("the documented Qwen service setup does not promise the discontinued OAuth account flow", () => {
  const qwen = agent("qwen-code");
  const route = accountRoute(qwen, "qwen-provider");
  assert.deepEqual(qwen.authMethods, []);
  assert.equal(route.purpose, "service");
  assert.equal(route.command, "qwen");
  assert.deepEqual(route.args, []);
  assert.match(route.inputHint, /\/auth/);
  assert.doesNotMatch(route.accountOwner, /Qwen 账号/);
});

test("subscription and Console handoffs retain different documented command choices", () => {
  const claude = agent("claude-agent");
  assert.deepEqual(accountRoute(claude, "claude-subscription").args, [
    "auth",
    "login",
  ]);
  assert.deepEqual(accountRoute(claude, "claude-console").args, [
    "auth",
    "login",
    "--console",
  ]);
  assert.equal(accountRoute(claude, "missing-method"), null);
  assert.deepEqual(
    claude.authMethods,
    [],
    "official source declarations are not this installation's declarations",
  );
});

test("an unknown custom Agent does not inherit behavior from its display name", () => {
  const result = accountCapabilities({
    id: "my-custom-agent",
    name: "Codex",
    authMethods: [],
  });
  assert.deepEqual(result.routes, []);
  assert.equal(result.evidence, "unknown");
  assert.equal(result.apiConfiguration.status, "unknown");
});

test("an explicit empty capability declaration overrides catalog defaults", () => {
  const custom = {
    ...agent("codex"),
    accountCapabilities: {
      accountOwner: "Custom",
      routes: [],
      localDeclaration: "not-read",
    },
    authenticationDeclaration: "not-read",
  };
  assert.deepEqual(accountCapabilities(custom).routes, []);
  assert.equal(accountCapabilities(custom).accountOwner, "Custom");
});

test("UI route selection cannot mutate another Agent or later registration handoff", () => {
  const first = accountRoute(agent("fast-agent"), "fast-agent-codex");
  first.args.push("--changed-by-view");
  first.registration.owner = "wrong owner";
  const next = accountRoute(agent("fast-agent"), "fast-agent-codex");
  assert.deepEqual(next.args, ["auth", "provider", "login", "codex"]);
  assert.equal(next.registration.owner, "OpenAI / ChatGPT");
});

test("all ten catalog entries distinguish documented simulation routes from installed success", () => {
  assert.equal(AGENT_CATALOG.length, 10);
  for (const item of AGENT_CATALOG) {
    const result = accountCapabilities(item);
    assert.ok(result.routes.length > 0, item.id);
    assert.equal(item.setupComplete, false);
    assert.equal(item.authentication, undefined);
    for (const route of result.routes) {
      assert.equal(route.evidence, "official-doc");
      assert.equal(route.execution, "simulation-only");
      assert.equal(route.requiresProgramConfirmation, true);
      assert.match(route.sourceUrl, /^https:\/\//);
      assert.equal(route.completion, "return-and-check");
      assert.equal(route.interaction.resultEvidence, "recheck-required");
      if (route.registration.status === "verified-entry") {
        assert.equal(route.registration.kind, "account-page");
        assert.match(route.registration.url, /^https:\/\//);
        assert.match(route.registration.sourceUrl, /^https:\/\//);
      } else {
        assert.equal(route.registration.status, "unknown");
        assert.equal(route.registration.availability, "provider-dependent");
        assert.equal(route.registration.url, undefined);
      }
    }
  }
});

test("account registration links are concrete evidence-backed entry pages, not login callbacks", () => {
  const expectations = [
    ["codex", "codex-login", "https://chatgpt.com/auth/login"],
    ["claude-agent", "claude-subscription", "https://claude.ai/"],
    ["claude-agent", "claude-console", "https://platform.claude.com/login"],
    [
      "gemini-cli",
      "gemini-google",
      "https://accounts.google.com/signup?utm_source=help",
    ],
  ];
  for (const [id, routeId, url] of expectations) {
    const value = accountRoute(agent(id), routeId);
    assert.equal(value.registration.status, "verified-entry");
    assert.equal(value.registration.url, url);
    assert.equal(value.registration.kind, "account-page");
    assert.equal(value.registration.callbackUrl, undefined);
    assert.equal(agent(id).authentication, undefined);
  }
});

test("Cline exposes two account registration pages without inventing a ClinePass account or installed methods", () => {
  const value = agent("cline");
  const route = accountRoute(value, "cline-provider");
  assert.equal(route.interaction.serviceSelection, "agent-owned");
  assert.deepEqual(
    route.registrationOptions.map((page) => page.id),
    ["cline", "chatgpt"],
  );
  assert.equal(route.registrationOptions[0].url, "https://app.cline.bot/");
  assert.match(route.registrationOptions[0].owner, /ClinePass/);
  assert.deepEqual(value.authMethods, []);
  assert.deepEqual(route.args, ["auth"]);
  route.registrationOptions[0].owner = "wrong account";
  route.interaction.serviceSelection = "wrong";
  const fresh = accountRoute(value, "cline-provider");
  assert.match(fresh.registrationOptions[0].owner, /ClinePass/);
  assert.equal(fresh.interaction.serviceSelection, "agent-owned");
});

test("multi-provider setup never gets a fabricated subscription or signup menu", () => {
  for (const [id, routeId] of [
    ["pi", "pi-provider"],
    ["opencode", "opencode-provider"],
    ["qwen-code", "qwen-provider"],
  ]) {
    const route = accountRoute(agent(id), routeId);
    assert.equal(route.interaction.serviceSelection, "agent-owned");
    assert.equal(route.registration.status, "unknown");
    assert.equal(route.registrationOptions, undefined);
    assert.equal(route.registration.url, undefined);
    assert.equal(route.interaction.providers, undefined);
  }
});

test("documented provider API support cannot enable Farfold shared credential delivery", () => {
  const item = agent("fast-agent");
  assert.equal(accountCapabilities(item).apiConfiguration.status, "documented");
  assert.equal(item.serviceCapabilities.status, "unknown");
  assert.deepEqual(item.apiFormats, []);
  assert.equal(item.serviceConfigurationReady, false);
});
