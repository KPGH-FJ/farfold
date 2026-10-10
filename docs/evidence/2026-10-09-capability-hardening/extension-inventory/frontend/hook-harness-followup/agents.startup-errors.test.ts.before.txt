import { beforeEach, expect, it, vi } from "vitest";
import type { AgentCardModel } from "./agents";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  states: [] as unknown[],
  cursor: 0,
  threads: new Map(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [
      h.states[index],
      (value: unknown) => {
        h.states[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(h.states[index])
            : value;
      },
    ];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("./sessions", () => ({
  threads: { getSnapshot: () => ({ threads: h.threads }) },
}));
import { useAgents } from "./agents";
import { STRINGS } from "./strings";

const card = {
  id: "custom-startup-fixture",
  name: "Fixture",
  status: "installed",
  registerable: false,
  custom: true,
} as AgentCardModel;
const render = () => {
  h.cursor = 0;
  return useAgents();
};
const failures = [
  ["AGENT_INITIALIZE_FAILED", "连接检查未完成，请检查程序或启动设置后重试"],
  [
    "AGENT_INITIALIZE_TIMEOUT",
    "连接检查超时，原因尚未确定。请先查看是否有待处理的登录或文件夹访问提示，再检查程序启动设置",
  ],
  ["AGENT_CONNECTION_ENDED", "连接在检查完成前结束，请检查程序后重试"],
  ["AGENT_START_FAILED", "程序未能启动，请检查程序文件和资料文件夹后重试"],
] as const;
const entries = ["connect", "reconnect", "install"] as const;

beforeEach(() => {
  h.states = [];
  h.threads.clear();
  h.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "app_initial_snapshot") return { agents: [] };
    if (command === "catalog_list") return [];
    return null;
  });
});

for (const entry of entries) {
  it.each(failures)(
    `${entry} displays %s and leaves the operation retryable`,
    async (code, text) => {
      const originalInvoke = h.invoke.getMockImplementation()!;
      h.invoke.mockImplementation(async (command: string, args: unknown) => {
        if (
          command === (entry === "install" ? "agent_install" : "agent_connect")
        )
          throw code;
        return originalInvoke(command, args);
      });
      const action = render();
      if (entry === "reconnect")
        await expect(action.reconnect(card, "/chosen-folder")).rejects.toBe(
          code,
        );
      else if (entry === "install")
        expect(await action.install(card)).toBe(false);
      else expect(await action.connect(card, "/chosen-folder")).toBe(false);
      expect(render().errors[card.id]).toBe(text);
      expect(render().busy[card.id]).toBeNull();
      if (entry === "install")
        expect(render().installProgress[card.id].stage).toBe("stopped");
      expect(h.invoke).toHaveBeenCalledWith("app_initial_snapshot");
      expect(h.invoke).toHaveBeenCalledWith("catalog_list");
      expect(
        h.invoke.mock.calls.some(([name]) => /prompt|auth/.test(name)),
      ).toBe(false);
    },
  );

  it.each([
    "AGENT_INITIALIZE_FAILED: secret-canary",
    "检查结果：AGENT_INITIALIZE_FAILED: secret-canary",
  ])(
    `${entry} keeps untrusted %s behind its existing fallback`,
    async (payload) => {
      const reason = new Error(payload);
      const originalInvoke = h.invoke.getMockImplementation()!;
      h.invoke.mockImplementation(async (command: string, args: unknown) => {
        if (
          command === (entry === "install" ? "agent_install" : "agent_connect")
        )
          throw reason;
        return originalInvoke(command, args);
      });
      const action = render();
      if (entry === "reconnect")
        await expect(action.reconnect(card, "/chosen-folder")).rejects.toBe(
          reason,
        );
      else if (entry === "install")
        expect(await action.install(card)).toBe(false);
      else expect(await action.connect(card, "/chosen-folder")).toBe(false);
      expect(render().errors[card.id]).toBe(
        entry === "install"
          ? STRINGS.install.failed
          : STRINGS.agents.errors.connectFailed,
      );
      expect(render().errors[card.id]).not.toContain("secret-canary");
    },
  );
}

it("keeps a failed first installation separate from connection and only retries on explicit action", async () => {
  const input = {
    declarationId: "fixture-model-v1",
    registryVersion: "1.0.0",
    launch: { kind: "uvx" as const, package: "fixture==1.0.0", args: ["-x"] },
    values: { model: "$system.chosen" },
  };
  const uninstalled = { ...card, custom: false, status: "none" as const };
  const originalInvoke = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "agent_install") throw "AGENT_INITIALIZE_FAILED";
    return originalInvoke(command, args);
  });
  await render().connect(uninstalled, "/chosen-folder", input);
  expect(render().errors[card.id]).toBe(failures[0][1]);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "agent_install"),
  ).toHaveLength(1);
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_connect")).toBe(
    false,
  );
  expect(input.values.model).toBe("$system.chosen");
  await render().connect(uninstalled, "/chosen-folder", input);
  const attempts = h.invoke.mock.calls.filter(
    ([name]) => name === "agent_install",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts.every(([, args]) => args.installationInput === input)).toBe(
    true,
  );
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_connect")).toBe(
    false,
  );
});

it("connects a registered card directly while a conversation connection exists", async () => {
  // Regression: a "connected" card (e.g. a live conversation connection)
  // fell into the register/install branch and the backend rejected it with
  // "请先结束任务并断开此 Agent，再更换程序".
  const connected = {
    ...card,
    custom: false,
    status: "connected" as const,
    registerable: true,
    discoveredPath: "/usr/local/bin/fixture",
  };
  expect(await render().connect(connected, "/chosen-folder")).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "agent_connect"),
  ).toHaveLength(1);
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_register")).toBe(
    false,
  );
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_install")).toBe(
    false,
  );
});
