import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_QWEN_METHOD } from "./fixtures/legacy-qwen-auth.js";
import { migrateLegacyQwenAuthentication } from "../src/prototype-migrations.js";
import {
  readPrototypeState,
  PROTOTYPE_STORAGE_KEY,
} from "../src/prototype-persistence.js";

const oldMethod = () => structuredClone(LEGACY_QWEN_METHOD);
const snapshot = (overrides = {}) => ({
  version: 6,
  tasks: [{ id: "kept", status: "done", prompt: "保留任务", queue: [] }],
  draft: {
    text: "保留草稿",
    files: [],
    folder: "/chosen",
    choice: { agent: "Qwen Code", model: "chosen", effort: "High" },
  },
  services: [{ id: "s", secretRevision: 3 }],
  agents: [
    {
      id: "qwen-code",
      name: "Qwen Code",
      authMethods: [oldMethod()],
      authMethodSelection: "terminal",
      ...overrides,
    },
  ],
});

test("remove exactly the captured Qwen fixture without replacing unrelated state", () => {
  const input = snapshot();
  const before = structuredClone(input);
  const result = migrateLegacyQwenAuthentication(input);
  assert.deepEqual(result.agents[0].authMethods, []);
  assert.equal(result.agents[0].authMethodSelection, undefined);
  assert.equal(result.tasks, input.tasks);
  assert.equal(result.draft, input.draft);
  assert.equal(result.services, input.services);
  assert.deepEqual(input, before);
  assert.equal(
    migrateLegacyQwenAuthentication(result),
    result,
    "migration is idempotent",
  );
});

test("preserve similar methods with any unknown or user-configured field", () => {
  const methods = [
    { ...oldMethod(), command: "/user/chosen/program" },
    { ...oldMethod(), manual: true },
    { ...oldMethod(), id: "user-terminal" },
    { ...oldMethod(), label: "我的登录方式" },
    { ...oldMethod(), accountLabel: "我的服务" },
    {
      ...oldMethod(),
      registration: {
        ...oldMethod().registration,
        url: "https://provider.example/signup",
      },
    },
    {
      ...oldMethod(),
      registration: { presentation: "official-login", demo: false },
    },
    { id: "terminal", type: "terminal", args: ["login"] },
  ];
  const input = snapshot({ authMethods: methods });
  assert.equal(migrateLegacyQwenAuthentication(input), input);
  const mixed = migrateLegacyQwenAuthentication(
    snapshot({ authMethods: [oldMethod(), ...methods] }),
  );
  assert.deepEqual(mixed.agents[0].authMethods, methods);
});

test("matching display names, other Agent ids and other snapshot versions are not migrated", () => {
  for (const id of ["custom-qwen", "registry:qwen-code", "codex"]) {
    const input = snapshot({ id });
    assert.equal(migrateLegacyQwenAuthentication(input), input);
  }
  const input = { ...snapshot(), version: 7 };
  assert.equal(migrateLegacyQwenAuthentication(input), input);
});

test("unfinished authentication and registration remain reviewable without a reusable old method", () => {
  const input = snapshot({
    accessJob: {
      id: "pending",
      type: "auth",
      status: "waiting",
      authMethod: oldMethod(),
      selection: { folder: "/original" },
    },
    registration: {
      kind: "account",
      methodId: "terminal",
      status: "waiting",
      open: true,
      selection: { folder: "/original" },
    },
  });
  const result = migrateLegacyQwenAuthentication(input);
  assert.deepEqual(result.agents[0].authMethods, []);
  assert.equal(result.agents[0].accessJob, input.agents[0].accessJob);
  assert.equal(result.agents[0].registration, input.agents[0].registration);
  assert.equal(result.agents[0].authMethodSelection, "terminal");
  assert.equal(result.agents[0].authentication, undefined);
});

test("old completed authentication becomes unverified without promoting the new service route", () => {
  const authentication = {
    method: "terminal",
    status: "flow-finished",
    entitlement: "unknown",
    folder: "/original",
  };
  const input = snapshot({
    authentication,
    authRequiredContexts: ["/original"],
  });
  const result = migrateLegacyQwenAuthentication(input);
  assert.deepEqual(result.agents[0].authentication, {
    ...authentication,
    status: "needs-check",
  });
  assert.deepEqual(result.agents[0].authRequiredContexts, ["/original"]);
  assert.equal(result.agents[0].accountRouteSelection, undefined);
  const custom = snapshot({
    authentication,
    authMethods: [
      oldMethod(),
      { id: "terminal", type: "terminal", command: "/user/chosen/login" },
    ],
  });
  assert.equal(
    migrateLegacyQwenAuthentication(custom).agents[0].authentication,
    authentication,
  );
});

test("the persistence read path applies migration and preserves the existing restart policy", () => {
  const input = snapshot({
    accessJob: {
      id: "pending",
      type: "auth",
      status: "waiting",
      authMethod: oldMethod(),
    },
  });
  const result = readPrototypeState({
    getItem(key) {
      assert.equal(key, PROTOTYPE_STORAGE_KEY);
      return JSON.stringify(input);
    },
  });
  assert.deepEqual(result.agents[0].authMethods, []);
  assert.equal(result.agents[0].accessJob.id, "pending");
  assert.equal(result.agents[0].accessJob.status, "unknown");
  assert.deepEqual(result.agents[0].accessJob.authMethod, oldMethod());
  assert.deepEqual(result.draft, input.draft);
  assert.equal(result.tasks[0].prompt, "保留任务");
  assert.deepEqual(result.services, input.services);
});
