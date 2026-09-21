import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  setters: [] as ReturnType<typeof vi.fn>[],
  cleanup: [] as (() => void)[],
  updateWork: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("./sessions", () => ({ threads: { updateWork: h.updateWork } }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const set = vi.fn();
    h.setters.push(set);
    return [initial, set];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => () => void) => h.cleanup.push(effect()),
}));
import { startWorkEvents, useWorkPolicy } from "./work_policy";
afterEach(() => {
  h.cleanup.splice(0).forEach((cleanup) => cleanup());
  h.setters.length = 0;
  vi.clearAllMocks();
});
it("does not replace a saved policy with an older initial read through a path alias", async () => {
  let event!: (event: { payload: unknown }) => void;
  h.listen.mockImplementation(async (_name, receive) => {
    event = receive;
    return () => {};
  });
  const off = startWorkEvents();
  let complete!: (value: unknown) => void;
  h.invoke.mockReturnValue(new Promise((resolve) => (complete = resolve)));
  useWorkPolicy("/alias");
  const saved = { cwd: "/canonical", enabled: { a: false } };
  event({ payload: saved });
  complete({ cwd: "/canonical", enabled: { a: true } });
  await Promise.resolve();
  expect(h.setters[0]).toHaveBeenLastCalledWith(saved);
  expect(h.updateWork).toHaveBeenLastCalledWith("/canonical", { a: false });
  off();
});
it("does not publish a failed policy save as success", async () => {
  h.invoke.mockImplementation(async (command) => {
    if (command === "agent_work_set") throw Error("storage failed");
    return { cwd: "/save-failure", enabled: { a: true } };
  });
  const policy = useWorkPolicy("/save-failure");
  await Promise.resolve();
  h.updateWork.mockClear();
  await policy.set("a", false);
  expect(h.updateWork).not.toHaveBeenCalled();
  expect(h.setters[0]).toHaveBeenLastCalledWith({
    cwd: "/save-failure",
    enabled: { a: true },
  });
  expect(h.setters[1]).toHaveBeenLastCalledWith(expect.any(String));
});
