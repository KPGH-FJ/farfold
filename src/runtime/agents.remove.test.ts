import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  states: [] as unknown[],
  cursor: 0,
  removed: true,
  kept: [] as string[],
  saveFailure: false,
  refreshFailure: false,
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

let useAgents: typeof import("./agents").useAgents;
let setupStorage: typeof import("./setup_storage").setupStorage;
const render = () => {
  h.cursor = 0;
  return useAgents();
};

beforeEach(async () => {
  vi.resetModules();
  h.states.length = 0;
  h.cursor = 0;
  h.removed = true;
  h.kept = [];
  h.saveFailure = false;
  h.refreshFailure = false;
  h.invoke.mockReset().mockImplementation(async (command) => {
    if (command === "agent_remove")
      return { removed: h.removed, keptInstallations: h.kept };
    if (command === "settings_set" && h.saveFailure)
      throw new Error("preparation save failed");
    if (command === "app_initial_snapshot") {
      if (h.refreshFailure) throw new Error("snapshot unavailable");
      return { agents: [] };
    }
    if (command === "catalog_list") return [];
    return null;
  });
  ({ useAgents } = await import("./agents"));
  ({ setupStorage } = await import("./setup_storage"));
  await setupStorage.complete("removed-agent");
  h.invoke.mockClear();
});

it("returns the actual removal result and refreshes after preparation progress fails to save", async () => {
  h.saveFailure = true;
  expect((await render().remove("removed-agent"))?.removed).toBe(true);
  expect(h.invoke).toHaveBeenCalledWith("app_initial_snapshot");
  expect(h.invoke).toHaveBeenCalledWith("catalog_list");
  expect(render().errors["removed-agent"]).toBeNull();
  expect(setupStorage.completed("removed-agent")).toBe(false);
  expect(setupStorage.snapshot().error).not.toBeNull();
  h.saveFailure = false;
  await setupStorage.flush();
  expect(setupStorage.snapshot().error).toBeNull();
});

it("keeps successful removal independent from a refresh failure and exposes the load error", async () => {
  h.refreshFailure = true;
  expect((await render().remove("removed-agent"))?.removed).toBe(true);
  expect(render().loadError).not.toBeNull();
  expect(render().errors["removed-agent"]).toBeNull();
  expect(setupStorage.completed("removed-agent")).toBe(false);
});

it("forwards requested managed uninstalls and reports kept directories", async () => {
  const outcome = await render().remove("removed-agent", {
    uninstall: ["a:one", "a:two"],
  });
  expect(outcome?.removed).toBe(true);
  expect(h.invoke).toHaveBeenCalledWith("agent_remove", {
    agentId: "removed-agent",
    uninstallInstallations: ["a:one", "a:two"],
  });
  expect(render().errors.__remove).toBeNull();

  h.kept = ["/agents/one（仍在使用）"];
  const second = await render().remove("removed-agent", {
    uninstall: ["a:one"],
  });
  expect(second?.keptInstallations).toEqual(["/agents/one（仍在使用）"]);
  expect(render().errors.__remove).toContain("/agents/one");
});

it("retains preparation completion when the backend reports no removal", async () => {
  h.removed = false;
  expect((await render().remove("removed-agent"))?.removed).toBe(false);
  expect(setupStorage.completed("removed-agent")).toBe(true);
  expect(h.invoke).toHaveBeenCalledWith("app_initial_snapshot");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "settings_set"),
  ).toBe(false);
});
