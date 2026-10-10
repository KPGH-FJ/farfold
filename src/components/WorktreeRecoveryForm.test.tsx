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
  choose: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
  worktrees: { recover: h.recover },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.choose }));
import { WorktreeRecoveryForm } from "./WorktreeRecoveryForm";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
import { removalRecovery as recovery } from "../runtime/worktree_remove.test-fixtures";
let props: ComponentProps<typeof WorktreeRecoveryForm>;
function render() {
  h.cursor = 0;
  return WorktreeRecoveryForm(props);
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
function name(value: string) {
  const field = nodes(render()).find((n) => n.type === "input")!;
  (field.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
  render();
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  render();
}
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.choose.mockReset().mockResolvedValue("/new");
  h.recover.mockReset().mockResolvedValue(undefined);
  props = { recovery, current: () => true, onClose: vi.fn() };
});
afterEach(() => h.slots.forEach((s) => s.cleanup?.()));
it("only the separate explicit restore button submits the chosen new parent and name; no draft applies", async () => {
  render();
  expect(button(S.recovery.confirm).props.disabled).toBe(true);
  expect(h.recover).not.toHaveBeenCalled();
  click(S.selectParent);
  await settle();
  name("restored");
  expect(button(S.recovery.confirm).props.disabled).toBe(false);
  click(S.recovery.confirm);
  await settle();
  expect(h.recover.mock.calls[0].slice(0, 3)).toEqual([
    recovery,
    "/new",
    "restored",
  ]);
  expect(h.recover).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(button(S.recovery.confirm).props.disabled).toBe(true);
  click(S.recovery.confirm);
  await settle();
  expect(h.recover).toHaveBeenCalledTimes(1);
});
it("a late directory chooser after owner replacement does not populate a new owner form", async () => {
  let resolve!: (p: string) => void;
  h.choose.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render();
  click(S.selectParent);
  props = { ...props, current: () => false };
  render();
  resolve("/late");
  await settle();
  expect(button(S.selectParent)).toBeDefined();
  expect(button(S.recovery.confirm).props.disabled).toBe(true);
  expect(h.recover).not.toHaveBeenCalled();
});
it("path traversal and empty names cannot dispatch restoration", async () => {
  render();
  click(S.selectParent);
  await settle();
  for (const bad of ["", "..", "../other", "nested/dir", "nested\\dir"]) {
    name(bad);
    click(S.recovery.confirm);
    expect(h.recover).not.toHaveBeenCalled();
  }
});
it("closing synchronously invalidates an already captured restore handler before React unmounts", async () => {
  render();
  click(S.selectParent);
  await settle();
  name("restored");
  const old = button(S.recovery.confirm).props.onClick as () => void;
  click(S.close);
  expect(props.onClose).toHaveBeenCalledOnce();
  old();
  await settle();
  expect(h.recover).not.toHaveBeenCalled();
});
it("the owner callback handed to a pending restore is false after close and unmount", async () => {
  let finish!: () => void;
  h.recover.mockImplementation(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  render();
  click(S.selectParent);
  await settle();
  name("restored");
  click(S.recovery.confirm);
  await settle();
  const current = h.recover.mock.calls[0][3] as () => boolean;
  expect(current()).toBe(true);
  click(S.close);
  h.slots.forEach((s) => s.cleanup?.());
  expect(current()).toBe(false);
  finish();
  await settle();
});
