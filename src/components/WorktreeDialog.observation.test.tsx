import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  cursor: 0,
  slots: [] as { value: unknown }[],
  held: false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../runtime/sessions", () => ({
  threads: { pauseQueuesForExit: vi.fn() },
}));
vi.mock("../runtime/setup_storage", () => ({
  setupStorage: { flush: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../runtime/draft_storage", () => ({
  useDraftSaveStatus: () => ({ interactionLocked: h.held }),
  draftPersistence: {
    snapshot: () => ({ interactionLocked: h.held }),
    acquireInteractionLock: () => {
      h.held = true;
      return () => {
        h.held = false;
      };
    },
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
const { WORKTREE_STRINGS: S } = await import("../runtime/worktree_strings");
const id = "original-operation";
function operation(settled = false) {
  return {
    kind: "operation",
    operationId: id,
    action: "archive",
    state: "unknown",
    settled,
    cancelRequested: false,
    maintenanceActive: !settled,
    originalPath: "/owned/tree",
    retainedPath: "/owned/retained/tree",
  };
}
const catalogue = (value: unknown) => ({
  locations: [],
  materials: [],
  archives: [],
  recoveries: [],
  operation: value,
});
type Element = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(value, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      out.push(child, ...nodes(child.props.children as ReactNode));
  });
  return out;
}
async function setup(value: unknown) {
  h.invoke.mockImplementation(async (command) => {
    if (command === "worktree_list") return catalogue(value);
    // Model the real IPC admission reply when both ORIGINAL Work closures
    // still own their slots. This is not a native-thread execution test.
    if (command === "worktree_recheck") throw { code: "busy" };
    if (command === "worktree_status") return value;
    if (command === "worktree_cancel") throw { code: "unknown" };
    throw Error(command);
  });
  const { worktrees } = await import("../runtime/worktrees");
  const { WorktreeDialog } = await import("./WorktreeDialog");
  await worktrees.load();
  const button = (label: string) => {
    h.cursor = 0;
    const view = WorktreeDialog({ cwd: null, target: null, onClose: vi.fn() });
    const result = nodes(view).find(
      (item) => item.type === "button" && item.props.children === label,
    );
    expect(result).toBeDefined();
    return result!;
  };
  const click = async (label: string) => {
    const found = button(label);
    expect(found.props.disabled).toBe(false);
    (found.props.onClick as () => void)();
    for (let n = 0; n < 24; n++) await Promise.resolve();
  };
  return { worktrees, button, click };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.cursor = 0;
  h.slots = [];
  h.held = false;
  h.invoke.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it("uses the reserved status route for the original unsettled owner while Work is saturated", async () => {
  const { worktrees: w, click } = await setup(operation());
  await click(S.check);
  expect(h.invoke.mock.calls).toContainEqual([
    "worktree_status",
    { operationId: id },
  ]);
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_recheck")).toBe(
    false,
  );
  expect(w.snapshot()).toMatchObject({
    operationId: id,
    operation: { state: "unknown", settled: false },
    uncertain: true,
    maintenanceLocked: true,
    working: false,
  });
  await expect(w.create(input, () => true)).rejects.toThrow();
});
it("keeps manual observation reachable after an unknown cancellation without replaying it", async () => {
  const { worktrees: w, click, button } = await setup(operation());
  await click(S.recycleCancelRequest);
  expect(w.snapshot().uncertain).toBe(true);
  await click(S.check);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_cancel")).toEqual([
    ["worktree_cancel", { operationId: id }],
  ]);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_status")).toEqual([
    ["worktree_status", { operationId: id }],
  ]);
  expect(button(S.recycleCancelRequest).props.disabled).toBe(false);
  expect(w.snapshot().maintenanceLocked).toBe(true);
});
it("observes an unknown operation ID through status without treating it as no work", async () => {
  const { worktrees: w, click } = await setup(operation());
  const unknown = { kind: "unknownOperation", operationId: id };
  h.invoke.mockImplementation(async (command) => {
    if (command === "worktree_status") return unknown;
    throw { code: "busy" };
  });
  await w.status();
  h.invoke.mockClear();
  await click(S.check);
  expect(h.invoke.mock.calls).toEqual([
    ["worktree_status", { operationId: id }],
  ]);
  expect(w.snapshot()).toMatchObject({
    operation: unknown,
    uncertain: true,
    maintenanceLocked: true,
  });
});
it("keeps a settled unknown on the actual recheck route and never promotes a status receipt", async () => {
  const { worktrees: w, click } = await setup(operation(true));
  h.invoke.mockImplementation(async (command) => {
    if (command === "worktree_recheck") return operation(true);
    throw Error(command);
  });
  await click(S.check);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_recheck")).toEqual(
    [["worktree_recheck", { operationId: id }]],
  );
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_status")).toBe(
    false,
  );
  expect(w.snapshot()).toMatchObject({
    uncertain: true,
    operation: { state: "unknown", settled: true },
    locations: [],
    archives: [],
  });
});
it("only observes a cold prepared owner and never starts it or releases maintenance", async () => {
  const prepared = { ...operation(), state: "prepared" };
  const { worktrees: w, click } = await setup(prepared);
  await click(S.check);
  expect(h.invoke.mock.calls).toEqual([
    ["worktree_list"],
    ["worktree_status", { operationId: id }],
  ]);
  expect(w.snapshot().operation).toEqual(prepared);
  expect(w.snapshot().maintenanceLocked).toBe(true);
  await expect(w.create(input, () => true)).rejects.toThrow();
});
it("uses the latest same-ID settled receipt to choose a real recheck", async () => {
  const { worktrees: w, button } = await setup(operation());
  const oldCheck = button(S.check).props.onClick as () => void;
  h.invoke.mockImplementation(async (command) => {
    if (command === "worktree_status" || command === "worktree_recheck")
      return operation(true);
    throw Error(command);
  });
  await w.status();
  h.invoke.mockClear();
  oldCheck();
  for (let n = 0; n < 24; n++) await Promise.resolve();
  expect(h.invoke.mock.calls).toEqual([
    ["worktree_recheck", { operationId: id }],
  ]);
});
it("a retained check handler cannot query a replacement operation", async () => {
  const { worktrees: w, button } = await setup(operation());
  const oldCheck = button(S.check).props.onClick as () => void;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_cancel")
      return {
        ...operation(true),
        state: "cancelled",
        cancelRequested: true,
      };
    if (command === "worktree_prepare_create")
      return {
        ...operation(true),
        operationId: args.operationId,
        action: "create",
        state: "failed",
      };
    throw Error(command);
  });
  await w.cancel();
  await w.create(input, () => true);
  expect(w.snapshot().operationId).not.toBe(id);
  h.invoke.mockClear();
  oldCheck();
  for (let n = 0; n < 24; n++) await Promise.resolve();
  expect(h.invoke).not.toHaveBeenCalled();
});
const input = {
  inspectionId: "owned-inspection",
  parentPath: "/owned",
  directoryName: "new",
  branch: { kind: "new", name: "new", startOid: "a".repeat(40) },
} as const;
it("after the 15 second prepare rejection observes its late prepared owner and only explicitly cancels", async () => {
  const { worktrees: w, click } = await setup(null);
  let originalId = "";
  let backend: unknown;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "worktree_prepare_create") {
      originalId = args.operationId;
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject({ code: "unknown" }), 15_000);
      });
    }
    if (command === "worktree_status") return backend;
    if (command === "worktree_cancel")
      return {
        ...(backend as object),
        state: "cancelled",
        settled: true,
        cancelRequested: true,
      };
    throw { code: "busy" };
  });
  const pending = w.create(input, () => true);
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(w.snapshot()).toMatchObject({
    operationId: originalId,
    operation: null,
    uncertain: true,
    working: false,
  });
  backend = {
    kind: "operation",
    operationId: originalId,
    action: "create",
    state: "prepared",
    settled: false,
    maintenanceActive: false,
    cancelRequested: false,
  };
  await click(S.check);
  expect(w.snapshot().operation).toEqual(backend);
  expect(h.invoke.mock.calls.filter(([c]) => c === "worktree_status")).toEqual([
    ["worktree_status", { operationId: originalId }],
  ]);
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_cancel")).toBe(
    false,
  );
  expect(h.invoke.mock.calls.some(([c]) => c === "worktree_start")).toBe(false);
  await expect(w.create(input, () => true)).rejects.toThrow();
  await click(S.cancel);
  expect(w.snapshot().operation).toMatchObject({
    operationId: originalId,
    state: "cancelled",
    settled: true,
  });
  expect(
    h.invoke.mock.calls.filter(([c]) => c === "worktree_prepare_create"),
  ).toHaveLength(1);
});
