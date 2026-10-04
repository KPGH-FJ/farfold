import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const effect = (setup: () => void | (() => void), deps: unknown[]) => {
    const slot = (hooks.slots[hooks.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((item, index) => !Object.is(item, slot.deps?.[index]))
    ) {
      hooks.pending.push(() => {
        slot.cleanup?.();
        slot.cleanup = setup() || undefined;
      });
      slot.deps = deps;
    }
  };
  return {
    ...(await original<typeof import("react")>()),
    useRef: (current: unknown) =>
      (hooks.slots[hooks.cursor++] ??= { value: { current } }).value,
    useState: (initial: unknown) => {
      const slot = (hooks.slots[hooks.cursor++] ??= { value: initial });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  browserSurfaceGuard as guard,
  useBrowserSurfaceBarrier,
} from "../runtime/browser_surface";
import { WorkspaceDialog } from "./WorkspaceDialog";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function render(requested: boolean) {
  hooks.cursor = 0;
  const ready = useBrowserSurfaceBarrier(requested);
  for (const effect of hooks.pending.splice(0)) effect();
  return ready;
}
async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.pending = [];
});
afterEach(async () => {
  for (const slot of hooks.slots) slot.cleanup?.();
  guard.requestClose();
  await settle();
  vi.unstubAllGlobals();
});

it("withholds a covering surface until close ACK and blocks reopen for its full lifetime", async () => {
  const close = deferred();
  guard.register(() => close.promise);
  expect(render(true)).toBe(false);
  expect(guard.canOpen).toBe(false);
  close.resolve();
  await settle();
  expect(render(true)).toBe(true);
  expect(guard.canOpen).toBe(false);
  expect(render(false)).toBe(false);
  expect(guard.canOpen).toBe(true);
});

it("keeps a failed covering surface hidden until explicit retry succeeds", async () => {
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("fixture"))
    .mockResolvedValueOnce(undefined);
  guard.register(close);
  expect(render(true)).toBe(false);
  await settle();
  expect(render(true)).toBe(false);
  expect(guard.getSnapshot().failed).toBe(true);
  guard.retry();
  await settle();
  expect(render(true)).toBe(true);
  expect(close).toHaveBeenCalledTimes(2);
});

it("does not revive a dismissed covering surface after a late ACK", async () => {
  const close = deferred();
  guard.register(() => close.promise);
  expect(render(true)).toBe(false);
  expect(render(false)).toBe(false);
  close.resolve();
  await settle();
  expect(render(false)).toBe(false);
  expect(guard.canOpen).toBe(true);
});

it("calls real WorkspaceDialog presentation only after native close ACK", async () => {
  const close = deferred();
  guard.register(() => close.promise);
  const dialog = {
    showModal: vi.fn(),
    close: vi.fn(),
    querySelectorAll: () => [],
  };
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  const view = () => {
    hooks.cursor = 0;
    const element = WorkspaceDialog({
      title: "Controlled dialog",
      onClose() {},
      children: null,
    }) as ReactElement<{ ref: { current: unknown } }>;
    element.props.ref.current = dialog;
    for (const effect of hooks.pending.splice(0)) effect();
  };
  view();
  expect(dialog.showModal).not.toHaveBeenCalled();
  close.resolve();
  await settle();
  view();
  expect(dialog.showModal).toHaveBeenCalledOnce();
});
