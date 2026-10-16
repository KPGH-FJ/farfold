import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value: unknown; cleanup?: () => void }[],
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
        slot.value =
          typeof next === "function"
            ? (next as (value: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useEffect: (setup: () => void | (() => void)) => {
    const slot = (h.slots[h.cursor++] ??= { value: null });
    if (!slot.value) {
      slot.value = true;
      slot.cleanup = setup() || undefined;
    }
  },
}));
import { SessionForkDialog } from "./SessionForkDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { SessionForkControl } from "../runtime/session_fork_control";
import { SESSION_FORK_STRINGS as S } from "../runtime/session_fork_strings";

type Element = { type: unknown; props: Record<string, unknown> };
let control: SessionForkControl;
let active: boolean;
let current: boolean;
const close = vi.fn();
function render() {
  h.cursor = 0;
  return SessionForkDialog({
    control,
    active,
    isCurrent: () => current,
    onClose: close,
  });
}
function nodes(node: ReactNode = render()): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          { type: child.type, props: child.props },
          ...nodes(child.props.children as ReactNode),
        ]
      : [],
  );
}
const button = (label: string, tree = nodes()) =>
  tree.find((node) => node.type === "button" && node.props.children === label);
const click = (label: string, tree = nodes()) =>
  (button(label, tree)!.props.onClick as () => void)();
const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
beforeEach(() => {
  h.slots = [];
  active = true;
  current = true;
  close.mockReset();
  control = {
    owner: {},
    phase: "idle",
    isCurrent: vi.fn(() => true),
    start: vi.fn(),
  };
});

it("requires explicit confirmation of complete current context and shared files", () => {
  const tree = render();
  expect(text(tree)).toContain(S.scope);
  expect(text(tree)).toContain(S.files);
  expect(text(tree)).toContain(S.permissions);
  expect(control.start).not.toHaveBeenCalled();
  click(S.cancel, nodes(tree));
  expect(close).toHaveBeenCalledOnce();
  expect(control.start).not.toHaveBeenCalled();
});

it("synchronously admits one confirmation and never infers success from dispatch", () => {
  const tree = nodes();
  click(S.confirm, tree);
  click(S.confirm, tree);
  expect(control.start).toHaveBeenCalledOnce();
  expect(button(S.confirm)!.props.disabled).toBe(true);
  expect(text(render())).not.toContain(S.ready);
});

it("rechecks the latest blocking and actual owner before a retained confirmation", () => {
  const tree = nodes();
  control = { ...control, blockedReason: "请先等待当前工作完成" };
  render();
  click(S.confirm, tree);
  expect(control.start).not.toHaveBeenCalled();
  expect(text(render())).toContain(control.blockedReason);
  control = { ...control, blockedReason: undefined, isCurrent: () => false };
  render();
  click(S.confirm, tree);
  expect(control.start).not.toHaveBeenCalled();
});

it("cannot reuse a prior idle confirmation after an unknown operation arrives", () => {
  const first = nodes();
  control = { ...control, phase: "unknown" };
  render();
  click(S.confirm, first);
  expect(control.start).not.toHaveBeenCalled();
  expect(button(S.confirm)).toBeUndefined();
});

it("keeps the common user vocabulary free of internal execution terms", () => {
  for (const value of Object.values(S))
    expect(value).not.toMatch(
      /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i,
    );
});

it.each(["visibility", "owner"] as const)(
  "does not revive old confirmation after %s A to B to A",
  (change) => {
    const first = nodes();
    const original = control;
    if (change === "visibility") active = false;
    else control = { ...control, owner: {} };
    render();
    active = true;
    control = original;
    render();
    click(S.confirm, first);
    expect(control.start).not.toHaveBeenCalled();
    click(S.confirm);
    expect(control.start).toHaveBeenCalledOnce();
  },
);

it("retires a confirmation on unmount and on the parent's synchronous guard", () => {
  const first = nodes();
  current = false;
  click(S.confirm, first);
  expect(control.start).not.toHaveBeenCalled();
  current = true;
  for (const slot of h.slots) slot.cleanup?.();
  click(S.confirm, first);
  expect(control.start).not.toHaveBeenCalled();
});

it.each(["pending", "unknown"] as const)(
  "closing %s only hides the window and does not retry or roll back",
  (phase) => {
    control = { ...control, phase };
    const tree = render();
    const all = nodes(tree);
    expect(button(S.confirm, all)).toBeUndefined();
    expect(button(S.continue, all)).toBeUndefined();
    expect(text(tree)).toContain(
      phase === "pending" ? S.background : S.noRetry,
    );
    const dialog = all.find((node) => node.type === WorkspaceDialog)!;
    expect(dialog.props.busy).toBeUndefined();
    (dialog.props.onClose as () => void)();
    expect(close).toHaveBeenCalledOnce();
    expect(control.start).not.toHaveBeenCalled();
  },
);

it("retains the exact created child and only explicitly continues that operation", () => {
  control = {
    ...control,
    phase: "created-unavailable",
    child: { nativeSessionId: "known-child-完整标识" },
    continue: vi.fn(),
  };
  const tree = nodes();
  expect(text(render())).toContain("known-child-完整标识");
  expect(button(S.open, tree)).toBeUndefined();
  click(S.continue, tree);
  click(S.continue, tree);
  expect(control.continue).toHaveBeenCalledOnce();
  expect(control.start).not.toHaveBeenCalled();
});

it("does not offer unsupported continuation or open an unknown unindexed child", () => {
  control = {
    ...control,
    phase: "unknown",
    child: { nativeSessionId: "kept-id" },
    openChild: vi.fn(),
  };
  expect(button(S.continue)).toBeUndefined();
  expect(button(S.open)).toBeUndefined();
  expect(text(render())).toContain("kept-id");
});

it("opens a ready indexed child only after the user clicks", () => {
  control = {
    ...control,
    phase: "ready",
    child: { nativeSessionId: "child", threadKey: "child-key", title: "副本" },
    openChild: vi.fn(),
  };
  const tree = nodes();
  expect(control.openChild).not.toHaveBeenCalled();
  expect(text(render())).toContain(S.ready);
  expect(text(render())).toContain(S.permissions);
  click(S.open, tree);
  click(S.open, tree);
  expect(control.openChild).toHaveBeenCalledOnce();
  expect(control.start).not.toHaveBeenCalled();
});

it.each(["ready", "rejected"] as const)(
  "prepares a new confirmation from a released %s result without dispatch",
  (phase) => {
    control = { ...control, phase, prepareNew: vi.fn() };
    const first = nodes();
    click(S.prepareNew, first);
    click(S.prepareNew, first);
    expect(control.prepareNew).toHaveBeenCalledOnce();
    expect(control.start).not.toHaveBeenCalled();
  },
);

it.each(["pending", "unknown", "created-unavailable"] as const)(
  "does not offer another copy while %s even if an invalid action is supplied",
  (phase) => {
    control = { ...control, phase, prepareNew: vi.fn() };
    expect(button(S.prepareNew)).toBeUndefined();
    expect(control.prepareNew).not.toHaveBeenCalled();
  },
);
