import { beforeEach, expect, it, vi } from "vitest";
import type { AgentCardModel } from "./agents";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  states: [] as unknown[],
  cursor: 0,
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
  useMemo: (read: () => unknown) => read(),
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("./sessions", () => ({ threads: {} }));
import { useAgents } from "./agents";

const input = {
  declarationId: "fixture-model-v1",
  registryVersion: "1.0.0",
  launch: { kind: "uvx" as const, package: "fixture==1.0.0", args: ["-x"] },
  values: { model: "$system.chosen" },
};
const card = {
  id: "registry:fixture",
  name: "Fixture",
  status: "none",
  registerable: false,
  custom: false,
} as AgentCardModel;
const render = () => {
  h.cursor = 0;
  return useAgents();
};
beforeEach(() => {
  h.states = [];
  h.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "app_initial_snapshot") return { agents: [] };
    if (command === "catalog_list") return [];
    return null;
  });
});

it("passes the same reviewed input to first install and explicit update", async () => {
  await render().connect(card, "/draft", input);
  expect(h.invoke).toHaveBeenCalledWith(
    "agent_install",
    expect.objectContaining({
      agentId: card.id,
      installationInput: input,
    }),
  );
  expect(
    h.invoke.mock.calls.findIndex(([name]) => name === "agent_install"),
  ).toBeLessThan(
    h.invoke.mock.calls.findIndex(([name]) => name === "agent_connect"),
  );
  h.invoke.mockClear();
  expect(await render().install({ ...card, status: "installed" }, input)).toBe(
    true,
  );
  expect(h.invoke).toHaveBeenCalledWith(
    "agent_install",
    expect.objectContaining({
      agentId: card.id,
      installationInput: input,
    }),
  );
});

it("keeps installation input across failure and retry without connecting a failed candidate", async () => {
  h.invoke.mockImplementationOnce(async () => {
    throw new Error("check failed");
  });
  await render().connect(card, "/draft", input);
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_connect")).toBe(
    false,
  );
  expect(input.values.model).toBe("$system.chosen");
  await render().connect(card, "/draft", input);
  const attempts = h.invoke.mock.calls.filter(
    ([name]) => name === "agent_install",
  );
  expect(attempts).toHaveLength(2);
  expect(
    attempts.every(
      ([, args]) => args.installationInput?.values.model === "$system.chosen",
    ),
  ).toBe(true);
});

it("does not apply an installation draft to a registered connection or historical selection", async () => {
  await render().connect({ ...card, status: "installed" }, "/draft", input);
  expect(h.invoke).toHaveBeenCalledWith("agent_connect", {
    agentId: card.id,
    cwd: "/draft",
  });
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_install")).toBe(
    false,
  );
  await render().selectInstallation(card.id, "older-program");
  expect(h.invoke).toHaveBeenCalledWith("agent_installation_select", {
    agentId: card.id,
    installationId: "older-program",
  });
});

it("keeps the submitted model choice while cancellation settles and never retries automatically", async () => {
  let finish!: (reason: Error) => void;
  h.invoke.mockImplementation((command: string) => {
    if (command === "agent_install")
      return new Promise((_, reject) => {
        finish = reject;
      });
    if (command === "app_initial_snapshot")
      return Promise.resolve({ agents: [] });
    if (command === "catalog_list") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  const installing = render().install(card, input);
  expect(render().busy[card.id]).toBe("install");
  await render().cancelInstall(card.id);
  expect(render().busy[card.id]).toBe("install");
  expect(input.values.model).toBe("$system.chosen");
  finish(new Error("cancelled"));
  expect(await installing).toBe(false);
  expect(render().busy[card.id]).toBeNull();
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "agent_install"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "agent_connect"),
  ).toBe(false);
  expect(input.values.model).toBe("$system.chosen");
});
