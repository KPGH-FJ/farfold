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
import { WorktreeDialog } from "./WorktreeDialog";
beforeEach(() => {
  h.cursor = 0;
  h.values = [];
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
  const old = render().find((n) => n.type === WorktreeDialog)!;
  (old.props.onClose as () => void)();
  open();
  const next = render().find((n) => n.type === WorktreeDialog)!;
  expect(next.props.target).not.toBe(old.props.target);
  (old.props.onClose as () => void)();
  expect(render().find((n) => n.type === WorktreeDialog)?.props.target).toBe(
    next.props.target,
  );
});
