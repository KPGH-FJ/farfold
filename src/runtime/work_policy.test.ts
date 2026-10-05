import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  cursor: 0,
  updateWork: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("./sessions", () => ({ threads: { updateWork: h.updateWork } }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, index) => value !== slot.deps?.[index])
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
}));
import {
  startWorkEvents,
  useWorkPolicy,
  type WorkSnapshot,
} from "./work_policy";

function effects() {
  for (const effect of h.effects.splice(0)) effect();
}
function render(cwd: string | null, commitEffects = true) {
  h.cursor = 0;
  const value = useWorkPolicy(cwd);
  if (commitEffects) effects();
  return value;
}
async function settle() {
  for (let index = 0; index < 4; index++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function events() {
  let event!: (event: { payload: WorkSnapshot }) => void;
  h.listen.mockImplementation(async (_name, receive) => {
    event = receive;
    return () => {};
  });
  const off = startWorkEvents();
  return { emit: (payload: WorkSnapshot) => event({ payload }), off };
}
function unavailable(value: ReturnType<typeof useWorkPolicy>) {
  expect(value.ready).toBe(false);
  expect(value.cwd).toBeUndefined();
  expect(value.locationEnabled).toBeUndefined();
  expect(value.legacyPaused).toBe(false);
  expect(value.enabled("a")).toBe(false);
  expect(value.error).toBeNull();
  expect(value.saving).toBe(false);
}

beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.cursor = 0;
  h.invoke.mockReset();
  h.listen.mockReset();
  h.updateWork.mockClear();
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.clearAllMocks();
});

it("does not replace a saved policy with an older initial read through a path alias", async () => {
  const event = events();
  const read = deferred<WorkSnapshot>();
  h.invoke.mockReturnValue(read.promise);
  render("/alias");
  const saved = { cwd: "/canonical", enabled: { a: false } };
  event.emit(saved);
  read.resolve({ cwd: "/canonical", enabled: { a: true } });
  await settle();
  const policy = render("/alias");
  expect(policy.cwd).toBe("/canonical");
  expect(policy.ready).toBe(true);
  expect(policy.enabled("a")).toBe(false);
  expect(h.updateWork).toHaveBeenLastCalledWith(
    "/canonical",
    { a: false },
    undefined,
  );
  event.off();
});

it("publishes explicit location settings without converting old per-Agent rules", async () => {
  const saved = { cwd: "/all", enabled: { old: true }, locationEnabled: false };
  h.invoke.mockResolvedValue(saved);
  render("/all");
  await settle();
  expect(await render("/all").setLocation(false)).toBe(true);
  expect(h.invoke).toHaveBeenLastCalledWith("agent_work_set", {
    agentId: null,
    cwd: "/all",
    enabled: false,
  });
  expect(h.updateWork).toHaveBeenLastCalledWith("/all", { old: true }, false);
  expect(render("/all").enabled("new-agent")).toBe(false);
});

it.each([null, "a"])(
  "does not publish a failed policy save for %s as success",
  async (agentId) => {
    h.invoke.mockImplementation(async (command) => {
      if (command === "agent_work_set") throw Error("storage failed");
      return { cwd: "/save-failure", enabled: { a: true } };
    });
    render("/save-failure");
    await settle();
    h.updateWork.mockClear();
    expect(await render("/save-failure").set(agentId, false)).toBe(false);
    expect(h.updateWork).not.toHaveBeenCalled();
    const policy = render("/save-failure");
    expect(policy.ready).toBe(true);
    expect(policy.enabled("a")).toBe(true);
    expect(policy.error).toEqual(expect.any(String));
    expect(policy.saving).toBe(false);
  },
);

it("invalidates an old canonical folder immediately, before the next effect or read", async () => {
  const next = deferred<WorkSnapshot>();
  h.invoke
    .mockResolvedValueOnce({ cwd: "/canonical-a", enabled: { a: true } })
    .mockReturnValueOnce(next.promise);
  render("/alias-a");
  await settle();
  const first = render("/alias-a");
  expect(first.cwd).toBe("/canonical-a");
  expect(first.enabled("a")).toBe(true);
  unavailable(render("/alias-b", false));
  expect(first.enabled("a")).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(await first.setLocation(false)).toBe(false);
  effects();
  unavailable(render("/alias-b"));
  next.resolve({ cwd: "/canonical-b", enabled: { a: false } });
  await settle();
  const second = render("/alias-b");
  expect(second.cwd).toBe("/canonical-b");
  expect(second.ready).toBe(true);
  expect(second.enabled("a")).toBe(false);
});

it("clears canonical access immediately when the selected folder becomes null", async () => {
  h.invoke.mockResolvedValue({ cwd: "/canonical-clear", enabled: { a: true } });
  render("/alias-clear");
  await settle();
  expect(render("/alias-clear").ready).toBe(true);
  const empty = render(null, false);
  unavailable(empty);
  expect(await empty.setLocation(true)).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  effects();
  unavailable(render(null));
});

it("rejects a late old-folder read even before its effect has been cleaned up", async () => {
  const first = deferred<WorkSnapshot>(),
    second = deferred<WorkSnapshot>();
  h.invoke
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  render("/slow-a");
  render("/slow-b", false);
  first.resolve({ cwd: "/canonical-slow-a", enabled: { a: true } });
  await settle();
  unavailable(render("/slow-b", false));
  expect(h.updateWork).not.toHaveBeenCalled();
  effects();
  second.resolve({ cwd: "/canonical-slow-b", enabled: { a: true } });
  await settle();
  expect(render("/slow-b").cwd).toBe("/canonical-slow-b");
});

it("accepts notifications only for the current alias's resolved folder and preserves newer notifications during a read", async () => {
  const event = events();
  const second = deferred<WorkSnapshot>();
  h.invoke
    .mockResolvedValueOnce({ cwd: "/event-a", enabled: { a: true } })
    .mockReturnValueOnce(second.promise);
  render("/event-alias-a");
  await settle();
  render("/event-alias-b", false);
  event.emit({ cwd: "/event-a", enabled: { a: false } });
  unavailable(render("/event-alias-b", false));
  effects();
  event.emit({
    cwd: "/event-b",
    enabled: { a: false },
    locationEnabled: false,
  });
  second.resolve({ cwd: "/event-b", enabled: { a: true } });
  await settle();
  expect(render("/event-alias-b").locationEnabled).toBe(false);
  event.emit({ cwd: "/event-a", enabled: { a: true }, locationEnabled: true });
  expect(render("/event-alias-b").locationEnabled).toBe(false);
  event.emit({ cwd: "/event-b", enabled: { a: false }, locationEnabled: true });
  expect(render("/event-alias-b").enabled("a")).toBe(true);
  event.off();
});

it.each(["saved", "failed"])(
  "does not let a late %s operation or its status replace the new folder",
  async (outcome) => {
    const save = deferred<WorkSnapshot>();
    h.invoke.mockImplementation((command, { cwd }) =>
      command === "agent_work_set"
        ? save.promise
        : Promise.resolve({
            cwd: cwd === "/save-alias-a" ? "/saved-a" : "/saved-b",
            enabled: { a: true },
          }),
    );
    render("/save-alias-a");
    await settle();
    const saving = render("/save-alias-a").setLocation(false);
    expect(render("/save-alias-a").saving).toBe(true);
    unavailable(render("/save-alias-b", false));
    effects();
    await settle();
    h.updateWork.mockClear();
    if (outcome === "saved")
      save.resolve({
        cwd: "/saved-a",
        enabled: { a: true },
        locationEnabled: false,
      });
    else save.reject(Error("old save failed"));
    expect(await saving).toBe(outcome === "saved");
    const current = render("/save-alias-b");
    expect(current.cwd).toBe("/saved-b");
    expect(current.enabled("a")).toBe(true);
    expect(current.error).toBeNull();
    expect(current.saving).toBe(false);
    if (outcome === "saved")
      expect(h.updateWork).toHaveBeenLastCalledWith(
        "/saved-a",
        { a: true },
        false,
      );
    else expect(h.updateWork).not.toHaveBeenCalled();
  },
);

it("invalidates a previous read synchronously on retry and ignores a captured retry from another folder", async () => {
  const second = deferred<WorkSnapshot>();
  h.invoke
    .mockResolvedValueOnce({ cwd: "/retry-canonical", enabled: { a: true } })
    .mockReturnValueOnce(second.promise);
  render("/retry-alias");
  await settle();
  const previous = render("/retry-alias");
  previous.retry();
  unavailable(render("/retry-alias", false));
  effects();
  second.resolve({ cwd: "/retry-canonical", enabled: { a: false } });
  await settle();
  expect(render("/retry-alias").enabled("a")).toBe(false);
  render(null);
  previous.retry();
  unavailable(render(null));
  expect(h.invoke).toHaveBeenCalledTimes(2);
});
