import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { SessionConfiguration } from "./session_configuration";
import { freshThreadState, normalizeConfigOptions } from "./session_projection";
import { STRINGS } from "./strings";

const option = (value: unknown = false, type = "boolean") => ({
  id: "feature",
  name: "Optional feature",
  category: "_feature",
  type,
  currentValue: value,
});

function fixture() {
  const a = freshThreadState("a", "fixture", "/a", "native-a");
  const b = freshThreadState("b", "fixture", "/b", "native-b");
  a.configOptions = normalizeConfigOptions([option()]);
  b.configOptions = normalizeConfigOptions([option()]);
  const states = new Map([
    ["a", a],
    ["b", b],
  ]);
  const finish = vi.fn();
  const configuration = new SessionConfiguration({
    thread: (key) => states.get(key),
    emit: vi.fn(),
    finish,
    permissionRevision: () => 0,
  });
  const reply = (options: unknown[] = [option(true)]) => ({
    configOptions: options,
    configOptionsModern: true,
    configCheck: {
      status: "ready",
      issues: [],
      protectedIds: [],
      current: { choices: [] },
    },
    permissionConfigId: null,
    permissionState: a.permissionState,
    service: null,
  });
  return { a, b, states, finish, configuration, reply };
}

beforeEach(() => {
  h.invoke.mockReset();
});

it.each([
  ["unchanged", [option(false)]],
  ["missing", []],
  ["string value", [option("true")]],
  ["changed type", [option(true, "select")]],
])(
  "does not confirm a boolean change when the receipt is %s",
  async (_, options) => {
    const { a, b, configuration, reply } = fixture();
    h.invoke.mockResolvedValue(reply(options));
    await expect(configuration.set("a", "feature", true)).rejects.toThrow(
      STRINGS.repair.configFailed,
    );
    expect(a.configError).toBe(STRINGS.repair.configFailed);
    expect(a.configOptions[0].currentValue).toBe(false);
    expect(b.configOptions[0].currentValue).toBe(false);
    expect(a.configuring).toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("publishes matching boolean receipts only after each setter completes", async () => {
  const { a, b, configuration, reply, finish } = fixture();
  let resolve!: (value: unknown) => void;
  h.invoke.mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  const pending = configuration.set("a", "feature", true);
  expect(a.configuring).toBe(true);
  expect(a.configOptions[0].currentValue).toBe(false);
  await expect(configuration.set("a", "feature", false)).rejects.toThrow();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  resolve(reply());
  await pending;
  expect(a.configOptions[0].currentValue).toBe(true);
  h.invoke.mockResolvedValueOnce(reply([option(false)]));
  await configuration.set("a", "feature", false);
  expect(a.configOptions[0].currentValue).toBe(false);
  expect(b.configOptions[0].currentValue).toBe(false);
  expect(h.invoke.mock.calls.map(([, args]) => args)).toEqual([
    {
      agentId: "fixture",
      cwd: "/a",
      sessionId: "native-a",
      configId: "feature",
      value: true,
    },
    {
      agentId: "fixture",
      cwd: "/a",
      sessionId: "native-a",
      configId: "feature",
      value: false,
    },
  ]);
  expect(finish).toHaveBeenCalledTimes(2);
  expect(a.configError).toBeNull();
});

it("retains the old value and reports a rejected setter without retry", async () => {
  const { a, configuration } = fixture();
  h.invoke.mockRejectedValue(new Error("fixture rejection"));
  await expect(configuration.set("a", "feature", true)).rejects.toThrow();
  expect(a.configOptions[0].currentValue).toBe(false);
  expect(a.configError).toBe(STRINGS.repair.configFailed);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("does not accept a late receipt after the connection was lost", async () => {
  const { a, configuration, reply } = fixture();
  let resolve!: (value: unknown) => void;
  h.invoke.mockImplementation(() => new Promise((done) => (resolve = done)));
  const pending = configuration.set("a", "feature", true);
  a.connectionLost = true;
  resolve(reply());
  await expect(pending).rejects.toThrow();
  expect(a.configOptions[0].currentValue).toBe(false);
  expect(a.connectionLost).toBe(true);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("rejects a setting for a conversation that no longer exists", async () => {
  const { configuration, states } = fixture();
  states.delete("a");
  await expect(configuration.set("a", "feature", true)).rejects.toThrow();
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(["modern", "legacy-mode"])(
  "rejects a late %s receipt after the conversation object was replaced",
  async (surface) => {
    const { a, states, configuration, reply } = fixture();
    let id = "feature";
    let value: unknown = true;
    if (surface === "legacy-mode") {
      id = "mode";
      value = "changed";
      a.modesSeparate = true;
      a.currentModeId = "original";
      a.configOptions = normalizeConfigOptions([
        {
          id,
          name: "Mode",
          type: "select",
          currentValue: "original",
          options: ["original", "changed"].map((value) => ({
            value,
            name: value,
          })),
        },
      ]);
    }
    let resolve!: (value: unknown) => void;
    h.invoke.mockImplementation(() => new Promise((done) => (resolve = done)));
    const pending = configuration.set("a", id, value);
    const replacement = freshThreadState("a", "fixture", "/a", "new-native");
    states.set("a", replacement);
    resolve(reply());
    await expect(pending).rejects.toThrow();
    expect(replacement.configOptions).toEqual([]);
    expect(replacement.configError).toBeNull();
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("retains a replacement conversation's pending setter when the old receipt arrives", async () => {
  const { a, states, configuration, reply } = fixture();
  let resolveOld!: (value: unknown) => void;
  let resolveNew!: (value: unknown) => void;
  h.invoke
    .mockImplementationOnce(() => new Promise((done) => (resolveOld = done)))
    .mockImplementationOnce(() => new Promise((done) => (resolveNew = done)));
  const old = configuration.set("a", "feature", true);
  const replacement = freshThreadState("a", "fixture", "/a", "new-native");
  replacement.configOptions = normalizeConfigOptions([option()]);
  states.set("a", replacement);
  const current = configuration.set("a", "feature", true);
  const tracked = configuration.requests.get("a");
  resolveOld(reply());
  await expect(old).rejects.toThrow();
  expect(configuration.requests.get("a")).toBe(tracked);
  expect(replacement.configuring).toBe(true);
  expect(a.configOptions[0].currentValue).toBe(false);
  resolveNew(reply());
  await current;
  expect(replacement.configOptions[0].currentValue).toBe(true);
  expect(configuration.requests.has("a")).toBe(false);
});
