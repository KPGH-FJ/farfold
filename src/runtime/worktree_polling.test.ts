import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  preparedRemoval,
  removalArchive,
  removalRecovery,
} from "./worktree_remove.test-fixtures";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  cursor: 0,
  slots: [] as { deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({ threads: { pauseQueuesForExit: vi.fn() } }));
vi.mock("./setup_storage", () => ({
  setupStorage: { flush: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (!slot.deps || deps.some((v, i) => !Object.is(v, slot.deps?.[i]))) {
      slot.deps = deps;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));
const running = {
  ...preparedRemoval,
  state: "running",
  removalPhase: "verifyingRecovery",
};
const list = {
  locations: [],
  materials: [],
  archives: [removalArchive],
  recoveries: [removalRecovery],
  operation: running,
};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  h.invoke.mockReset().mockImplementation(async (command) => {
    if (command === "worktree_list") return list;
    if (command === "settings_get") return null;
    if (command === "worktree_status") return running;
    throw Error(command);
  });
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.useRealTimers();
});
async function mount() {
  const { worktrees, useWorktrees } = await import("./worktrees");
  await worktrees.load();
  const render = () => {
    h.cursor = 0;
    useWorktrees();
    h.effects.splice(0).forEach((effect) => effect());
  };
  render();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  render();
  return { worktrees, render };
}
it.each([true, false])(
  "does not retire a held canonical list through an automatic status poll (React render=%s), then resumes after receipt",
  async (rerender) => {
    const { worktrees: w, render } = await mount();
    let finish!: (v: unknown) => void;
    let holding = true;
    h.invoke.mockImplementation(async (command) => {
      if (command === "worktree_list")
        return holding
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : list;
      if (command === "worktree_status") return running;
      throw Error(command);
    });
    const read = w.load();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const joined = w.load();
    if (rerender) render();
    const reads = h.invoke.mock.calls.filter(
      ([c]) => c === "worktree_list",
    ).length;
    await vi.advanceTimersByTimeAsync(1650);
    expect(
      h.invoke.mock.calls.filter(([c]) => c === "worktree_status"),
    ).toHaveLength(0);
    expect(
      h.invoke.mock.calls.filter(([c]) => c === "worktree_list"),
    ).toHaveLength(reads);
    expect(w.snapshot().maintenanceLocked).toBe(true);
    holding = false;
    finish(list);
    await Promise.all([read, joined]);
    expect(w.snapshot().error).toBeNull();
    expect(w.snapshot().recoveries[0].availability).toBe("verified");
    render();
    await vi.advanceTimersByTimeAsync(1050);
    expect(
      h.invoke.mock.calls.filter(([c]) => c === "worktree_status"),
    ).toHaveLength(1);
    expect(
      h.invoke.mock.calls.some(([c]) =>
        ["worktree_start", "worktree_remove_confirm"].includes(c),
      ),
    ).toBe(false);
  },
);
