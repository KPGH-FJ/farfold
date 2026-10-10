import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => (h.values[h.cursor++] ??= { current }),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.values)) h.values[i] = initial;
    return [
      h.values[i],
      (v: unknown) => {
        h.values[i] = typeof v === "function" ? v(h.values[i]) : v;
      },
    ];
  },
}));
import { WorkLocationPicker } from "./WorkLocationPicker";
import { worktreeManagement } from "../runtime/worktree_management";
beforeEach(() => {
  h.cursor = 0;
  h.values = [];
  const old = worktreeManagement.snapshot();
  if (old) worktreeManagement.close(old);
});
it("an old dialog's close callback cannot close a newer location choice", () => {
  const begin = vi.fn(() => ({
    isCurrent: () => true,
    apply: async () => true,
  }));
  const render = () => {
    h.cursor = 0;
    const node = WorkLocationPicker({ cwd: null, disabled: false, begin });
    return Children.toArray(node.props.children as ReactNode).filter(
      isValidElement,
    ) as ReactElement<Record<string, unknown>>[];
  };
  const open = () =>
    (render().find((n) => n.type === "button")!.props.onClick as () => void)();
  open();
  const old = worktreeManagement.snapshot()!;
  worktreeManagement.close(old);
  open();
  const next = worktreeManagement.snapshot()!;
  expect(next.target).not.toBe(old.target);
  worktreeManagement.close(old);
  expect(worktreeManagement.snapshot()).toBe(next);
});

it("disabling or unmounting the draft picker does not discard management", () => {
  const target = { isCurrent: () => true, apply: async () => true };
  const opened = worktreeManagement.open({ cwd: "/repo", target });
  h.cursor = 0;
  WorkLocationPicker({ cwd: null, disabled: true, begin: () => null });
  expect(worktreeManagement.snapshot()).toBe(opened);
  worktreeManagement.close(opened);
  const recovery = worktreeManagement.open({ cwd: null, target: null });
  worktreeManagement.close(opened);
  expect(worktreeManagement.snapshot()).toBe(recovery);
});

it("a retained picker callback does not combine a new draft with the previous cwd", () => {
  const target = { isCurrent: () => true, apply: async () => true };
  const render = (cwd: string) => {
    h.cursor = 0;
    return WorkLocationPicker({ cwd, disabled: false, begin: () => target });
  };
  const first = render("/old");
  const oldButton = Children.toArray(first.props.children as ReactNode).find(
    isValidElement,
  ) as ReactElement<{ onClick: () => void }>;
  render("/new");
  oldButton.props.onClick();
  expect(worktreeManagement.snapshot()?.cwd).toBe("/new");
});
