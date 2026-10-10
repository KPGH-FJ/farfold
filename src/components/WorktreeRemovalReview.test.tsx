import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    cleanup?: () => void;
    deps?: readonly unknown[];
  }[],
  inspect: vi.fn(),
  prepare: vi.fn(),
  confirm: vi.fn(),
  withdraw: vi.fn(),
  canConfirm: vi.fn(),
  state: { operation: null } as { operation: unknown },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: () => h.state,
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useState: (initial: unknown) => {
    const s = (h.slots[h.cursor++] ??= { value: initial });
    return [
      s.value,
      (v: unknown) => {
        s.value = typeof v === "function" ? v(s.value) : v;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
    const i = h.cursor++,
      old = h.slots[i];
    if (!old || deps.some((v, n) => !Object.is(v, old.deps?.[n]))) {
      old?.cleanup?.();
      h.slots[i] = { deps, cleanup: fn() || undefined };
    }
  },
}));
vi.mock("../runtime/worktrees", () => ({
  worktrees: {
    inspectRemoval: h.inspect,
    prepareRemoval: h.prepare,
    confirmRemoval: h.confirm,
    withdrawRemoval: h.withdraw,
    canConfirmRemoval: h.canConfirm,
    subscribe: vi.fn(),
    snapshot: () => h.state,
  },
}));
import { WorktreeRemovalReview } from "./WorktreeRemovalReview";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
import {
  removalArchive as archive,
  removalInspection as ticket,
  preparedRemoval,
} from "../runtime/worktree_remove.test-fixtures";
const M = S.removal;
let props: ComponentProps<typeof WorktreeRemovalReview>;
function render() {
  h.cursor = 0;
  return WorktreeRemovalReview(props);
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      out.push(child, ...nodes(child.props.children as ReactNode));
  });
  return out;
}
function button(label: string) {
  return nodes(render()).find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
}
function click(label: string) {
  (button(label).props.onClick as () => void)();
}
function check(checked = true) {
  const input = nodes(render()).find((n) => n.type === "input")!;
  (input.props.onChange as (e: unknown) => void)({
    currentTarget: { checked },
  });
  render();
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  render();
}
function unmount() {
  h.slots.forEach((s) => s.cleanup?.());
  h.slots = [];
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.state = { operation: null };
  h.inspect.mockReset().mockResolvedValue(ticket);
  h.confirm.mockReset().mockResolvedValue(undefined);
  h.withdraw
    .mockReset()
    .mockImplementation(() => h.canConfirm.mockReturnValue(false));
  h.canConfirm.mockReset().mockReturnValue(false);
  h.prepare.mockReset().mockImplementation(async () => {
    h.state = { operation: preparedRemoval };
    h.canConfirm.mockReturnValue(true);
  });
  props = { archive, current: () => true, onClose: vi.fn() };
});
afterEach(unmount);
it("first explicit action prepares only; synchronous success creates a new unchecked second decision without a form submit", async () => {
  render();
  await settle();
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(button(M.prepare).props.disabled).toBe(true);
  check();
  const oldPrepare = button(M.prepare).props.onClick as () => void;
  expect(button(M.prepare).props.type).toBe("button");
  oldPrepare();
  await settle();
  oldPrepare();
  await settle();
  expect(h.prepare).toHaveBeenCalledTimes(1);
  expect(h.confirm).not.toHaveBeenCalled();
  expect(button(M.confirm).props.type).toBe("button");
  expect(button(M.confirm).props.disabled).toBe(true);
  expect(
    nodes(render()).some((n) => n.type === "form" || n.props.autoFocus),
  ).toBe(false);
  click(M.confirm);
  expect(h.confirm).not.toHaveBeenCalled();
  check();
  click(M.confirm);
  await settle();
  expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
    h.prepare.mock.calls[0][1],
    preparedRemoval,
  );
});
it("withdrawing the second checkbox invalidates even an already captured confirmation click", async () => {
  render();
  await settle();
  check();
  click(M.prepare);
  await settle();
  check();
  const stale = button(M.confirm).props.onClick as () => void;
  check(false);
  stale();
  await settle();
  expect(h.confirm).not.toHaveBeenCalled();
});
it("a newer prepared recovery receipt never inherits an earlier checkbox", async () => {
  render();
  await settle();
  check();
  click(M.prepare);
  await settle();
  check();
  const stale = button(M.confirm).props.onClick as () => void;
  h.state = {
    operation: {
      ...preparedRemoval,
      recovery: { ...preparedRemoval.recovery, revision: 2 },
    },
  };
  render();
  expect(button(M.confirm).props.disabled).toBe(true);
  stale();
  click(M.confirm);
  await settle();
  expect(h.confirm).not.toHaveBeenCalled();
  check();
  click(M.confirm);
  await settle();
  expect(h.confirm).toHaveBeenCalledTimes(1);
});
it("a closed owner cancels its preparation and a newly opened panel does not inherit its prepared decision", async () => {
  render();
  await settle();
  check();
  click(M.prepare);
  await settle();
  check();
  const stale = button(M.confirm).props.onClick as () => void,
    owner = h.prepare.mock.calls[0][1];
  click(S.recycleCancel);
  expect(h.withdraw).toHaveBeenCalledWith(owner);
  expect(props.onClose).toHaveBeenCalledOnce();
  unmount();
  render();
  await settle();
  stale();
  await settle();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(button(M.prepare)).toBeDefined();
  expect(button(M.confirm)).toBeUndefined();
});
it("retired management ownership rejects a late enabled click without any deletion", async () => {
  render();
  await settle();
  check();
  click(M.prepare);
  await settle();
  check();
  const stale = button(M.confirm).props.onClick as () => void;
  props = { ...props, current: () => false };
  render();
  stale();
  await settle();
  expect(h.confirm).not.toHaveBeenCalled();
});
it("blocked content has no waiver and shows a single explanation while preserving the inspection", async () => {
  const blocked = {
    ...ticket,
    blockers: ["unsentWork", "unsentWork"],
    impact: { conversations: 1, unsent: true },
  };
  h.inspect.mockResolvedValue(blocked);
  render();
  await settle();
  expect(nodes(render()).some((n) => n.type === "input")).toBe(false);
  expect(button(M.prepare).props.disabled).toBe(true);
  expect(
    renderToStaticMarkup(render()).split(S.errors.unsentWork),
  ).toHaveLength(2);
  click(M.prepare);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(blocked.blockers).toHaveLength(2);
});
it("preparation in progress exposes no delete control and no not-yet-deleted claim after dispatch", async () => {
  h.prepare.mockImplementation(async () => {
    h.state = {
      operation: {
        ...preparedRemoval,
        state: "running",
        removalPhase: "preparingRecovery",
        recovery: undefined,
      },
    };
  });
  render();
  await settle();
  check();
  click(M.prepare);
  await settle();
  expect(button(M.confirm)).toBeUndefined();
  expect(renderToStaticMarkup(render())).toContain(M.phases.preparingRecovery);
  h.state = {
    operation: {
      ...preparedRemoval,
      state: "running",
      removalPhase: "deleting",
      deleteDispatched: true,
    },
  };
  render();
  expect(renderToStaticMarkup(render())).not.toContain(M.prepared);
  expect(renderToStaticMarkup(render())).toContain(M.phases.deleting);
});

it("closing an unsubmitted delete review synchronously invalidates its captured first action", async () => {
  render();
  await settle();
  check();
  const old = button(M.prepare).props.onClick as () => void;
  click(S.recycleCancel);
  old();
  await settle();
  expect(h.prepare).not.toHaveBeenCalled();
});
