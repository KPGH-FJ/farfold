import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentConnectionStatus } from "./agents";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  publish: vi.fn(),
  effect: undefined as (() => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [null, h.publish],
  useEffect: (run: () => () => void) => {
    h.effect = run();
  },
}));
import { useConnectionAccount } from "./connection_account";
const status = (
  account: AgentConnectionStatus["account"] = {
    kind: "account",
    email: "user@example.test",
  },
  state = "ready",
): AgentConnectionStatus => ({
  agentId: "fixture",
  cwd: "/work",
  connectionId: "prepared",
  purpose: "preparation",
  state,
  account,
  authMethods: [],
  agentName: null,
  agentVersion: null,
});
let emit: (value: AgentConnectionStatus) => void;
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
  h.invoke.mockReset();
  h.listen.mockReset();
  h.publish.mockClear();
  h.listen.mockImplementation(async (_name, callback) => {
    emit = (value) => callback({ payload: value });
    return vi.fn();
  });
});
afterEach(() => {
  h.effect?.();
  h.effect = undefined;
});
it("a stale initial snapshot cannot revive a closed account or erase its replacement report", async () => {
  let snapshot!: (value: AgentConnectionStatus[]) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      snapshot = resolve;
    }),
  );
  useConnectionAccount("fixture", "/work");
  await settle();
  emit(status(undefined, "closed"));
  snapshot([status()]);
  await settle();
  expect(h.publish.mock.calls.at(-1)?.[0].account).toBeNull();
  emit({ ...status({ kind: "none" }), connectionId: "replacement" });
  await settle();
  expect(h.publish.mock.calls.at(-1)?.[0].account).toEqual({ kind: "none" });
  emit(status(undefined, "closed"));
  await settle();
  expect(h.publish.mock.calls.at(-1)?.[0].account).toEqual({ kind: "none" });
});
it("leaving a target suppresses a late account snapshot", async () => {
  let snapshot!: (value: AgentConnectionStatus[]) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      snapshot = resolve;
    }),
  );
  useConnectionAccount("fixture", "/work");
  await settle();
  h.effect?.();
  h.effect = undefined;
  snapshot([status()]);
  await settle();
  expect(h.publish).not.toHaveBeenCalled();
});
it("API services do not subscribe or query the Agent's unrelated subscription", () => {
  useConnectionAccount("fixture", "/work", "selected-api");
  expect(h.listen).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
