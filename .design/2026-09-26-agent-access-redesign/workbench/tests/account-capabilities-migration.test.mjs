import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_CAPABILITIES,
  ACCOUNT_CAPABILITIES_VERSION,
  accountRoute,
  migrateBuiltinAccountCapabilities,
} from "../src/account-capabilities.js";

// Literal persisted shape from the earlier prototype, not produced from the
// current catalog. This catches browser state masking added registration pages.
const oldClineMetadata = () => ({
  accountOwner: "Cline 或所选模型服务提供商",
  localDeclaration: "not-read",
  checkedAt: "2026-09-26",
  evidence: "official-doc",
  routes: [
    {
      id: "cline-provider",
      kind: "terminal",
      label: "登录或配置模型服务",
      actionLabel: "登录或配置模型服务",
      command: "cline",
      args: ["auth"],
      sourceUrl: "https://docs.cline.bot/cline-cli/getting-started",
      evidence: "official-doc",
      execution: "simulation-only",
      purpose: "service",
      completion: "return-and-check",
      requiresProgramConfirmation: true,
      accountOwner: "Cline 或所选模型服务提供商",
      registration: {
        owner: "Cline 或所选模型服务提供商",
        kind: "during-auth",
        availability: "provider-dependent",
      },
      inputHint: "按终端提示选择账号或自己的模型服务。",
    },
  ],
  apiConfiguration: {
    status: "documented",
    sourceUrl: "https://docs.cline.bot/cline-cli/getting-started",
    delivery: "agent-owned",
    farfoldDelivery: "separate-capability",
  },
});
const persistedCline = () => ({
  id: "cline",
  name: "My Cline",
  accountCapabilities: oldClineMetadata(),
  authMethods: [{ id: "actual-method", type: "terminal", args: ["custom"] }],
  authenticationDeclaration: "program-reported",
  selectedInstallationId: "my-program",
  accountRouteSelection: "cline-provider",
  authMethodSelection: "actual-method",
  setupDraft: { folder: "/my-project", model: "selected-model", test: "idle" },
  setupEvidence: { result: "preserved" },
  authentication: { status: "unknown", folder: "/my-project" },
  accessJob: { id: "pending-job", selection: { model: "selected-model" } },
  registered: true,
  connected: true,
});

test("restored old Cline metadata gains verified registration entries without resetting user state", () => {
  const before = JSON.parse(JSON.stringify(persistedCline()));
  const snapshot = structuredClone(before);
  const after = migrateBuiltinAccountCapabilities(before);
  assert.notEqual(after, before);
  assert.equal(
    after.accountCapabilities.catalogMetadataVersion,
    ACCOUNT_CAPABILITIES_VERSION,
  );
  const route = accountRoute(after, "cline-provider");
  assert.equal(route.interaction.serviceSelection, "agent-owned");
  assert.deepEqual(
    route.registrationOptions.map((page) => page.url),
    ["https://app.cline.bot/", "https://chatgpt.com/auth/login"],
  );
  for (const key of Object.keys(before).filter(
    (key) => key !== "accountCapabilities",
  ))
    assert.equal(after[key], before[key], key);
  assert.deepEqual(before, snapshot);
  assert.equal(after.authMethods[0].id, "actual-method");
});

test("explicit custom or empty declarations remain authoritative even with a known Agent ID", () => {
  const variants = [
    (value) => {
      value.routes = [];
    },
    (value) => {
      value.routes[0].command = "/custom/cline";
    },
    (value) => {
      value.routes[0].args = ["auth", "different"];
    },
    (value) => {
      value.routes[0].sourceUrl = "https://example.test/docs";
    },
    (value) => {
      value.routes[0].id = "custom-route";
    },
    (value) => {
      value.routes[0].label = "My custom action";
    },
    (value) => {
      value.routes[0].registration.url = "https://example.test/register";
    },
    (value) => {
      value.routes[0].customRule = true;
    },
    (value) => {
      value.apiConfiguration.status = "custom";
    },
    (value) => {
      value.customFlag = "preserve";
    },
    (value) => {
      value.localDeclaration = "program-reported";
    },
    (value) => {
      value.evidence = "custom";
    },
  ];
  for (const change of variants) {
    const agent = persistedCline();
    change(agent.accountCapabilities);
    assert.equal(migrateBuiltinAccountCapabilities(agent), agent);
  }
});

test("missing metadata and custom Agents never acquire catalog capability through this migration", () => {
  for (const value of [
    { id: "cline" },
    { id: "cline", accountCapabilities: null },
    { ...persistedCline(), id: "my-custom-cline" },
    { ...persistedCline(), id: "codex" },
  ])
    assert.equal(migrateBuiltinAccountCapabilities(value), value);
});

test("current, unknown, and future metadata versions are not overwritten", () => {
  for (const version of [ACCOUNT_CAPABILITIES_VERSION, 0, 999, null]) {
    const value = persistedCline();
    value.accountCapabilities.catalogMetadataVersion = version;
    assert.equal(migrateBuiltinAccountCapabilities(value), value);
  }
  const migrated = migrateBuiltinAccountCapabilities(persistedCline());
  assert.equal(migrateBuiltinAccountCapabilities(migrated), migrated);
});

test("the last unversioned built-in copy is marked without sharing mutable catalog data", () => {
  const metadata = structuredClone(ACCOUNT_CAPABILITIES.cline);
  delete metadata.catalogMetadataVersion;
  const migrated = migrateBuiltinAccountCapabilities({
    id: "cline",
    accountCapabilities: metadata,
  });
  assert.equal(
    migrated.accountCapabilities.catalogMetadataVersion,
    ACCOUNT_CAPABILITIES_VERSION,
  );
  migrated.accountCapabilities.routes[0].registrationOptions[0].owner =
    "mutated";
  assert.notEqual(
    ACCOUNT_CAPABILITIES.cline.routes[0].registrationOptions[0].owner,
    "mutated",
  );
  assert.notEqual(metadata.routes[0].registrationOptions[0].owner, "mutated");
});

test("all known original route shapes migrate without adding invented provider menus", () => {
  for (const [id, builtin] of Object.entries(ACCOUNT_CAPABILITIES)) {
    const metadata = structuredClone(builtin);
    delete metadata.catalogMetadataVersion;
    for (const route of metadata.routes) {
      delete route.interaction;
      delete route.declarationSourceUrl;
      delete route.registrationOptions;
      route.registration = {
        owner: id === "qwen-code" ? "所选模型服务提供商" : route.accountOwner,
        kind: id === "qwen-code" ? "provider-page" : "during-auth",
        availability: "provider-dependent",
      };
    }
    const result = migrateBuiltinAccountCapabilities({
      id,
      accountCapabilities: metadata,
    });
    assert.equal(
      result.accountCapabilities.catalogMetadataVersion,
      ACCOUNT_CAPABILITIES_VERSION,
      id,
    );
    if (["pi", "opencode", "qwen-code"].includes(id)) {
      assert.equal(
        result.accountCapabilities.routes[0].registration.status,
        "unknown",
      );
      assert.equal(
        result.accountCapabilities.routes[0].registrationOptions,
        undefined,
      );
    }
  }
});
