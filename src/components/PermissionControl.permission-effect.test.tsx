import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[] }[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (value: unknown) => {
        slot.value = value;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(effect);
      slot.deps = deps;
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { PermissionControl } from "./PermissionControl";
import { WorkspacePopover } from "./WorkspacePopover";
import { WorkspaceDialog } from "./WorkspaceDialog";
import {
  freshThreadState,
  normalizeConfigOptions,
} from "../runtime/session_projection";
import { threads } from "../runtime/sessions";
import type { ThreadState } from "../runtime/session_types";
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(node, (item) => {
    if (isValidElement<Record<string, unknown>>(item))
      out.push(item, ...elements(item.props.children as ReactNode));
  });
  return out;
}
function text(node: ReactNode): string {
  let out = "";
  Children.forEach(node, (item) => {
    if (typeof item === "string") out += item;
    else if (isValidElement<Record<string, unknown>>(item))
      out += text(item.props.children as ReactNode);
  });
  return out;
}
function seed(): ThreadState {
  const s = freshThreadState("same-key", "generic-agent", "/owned", "same-id");
  s.permissionConfigId = "mode";
  s.permissionState = "ready";
  s.permissionEffect = {
    configId: "mode",
    appliesAt: "next_ordinary_prompt",
    currentScope: "unknown",
  };
  s.configOptions = normalizeConfigOptions([
    {
      id: "mode",
      category: "mode",
      type: "select",
      name: "Permission",
      currentValue: "ask",
      options: [
        { value: "ask", name: "Ask" },
        { value: "read", name: "Read" },
      ],
    },
  ]);
  return s;
}
function view() {
  const slots: typeof h.slots = [];
  return (s: ThreadState) => {
    h.slots = slots;
    h.cursor = 0;
    const tree = elements(PermissionControl({ thread: s }));
    for (const effect of h.effects.splice(0)) effect();
    return tree;
  };
}
function choose(tree: Element[], value: string) {
  const popover = tree.find((item) => item.type === WorkspacePopover)!;
  const menu = elements(
    (popover.props.children as (close: () => void) => ReactNode)(() => {}),
  );
  const choice = menu.find(
    (item) =>
      item.props.role === "radio" &&
      text(item.props.children as ReactNode).startsWith(value),
  )!;
  (choice.props.onClick as () => void)();
}
function apply(tree: Element[]) {
  const dialog = tree.find((item) => item.type === WorkspaceDialog)!;
  const primary = elements(dialog.props.children as ReactNode).find(
    (item) =>
      item.type === "button" &&
      String(item.props.className).includes("btn-primary"),
  )!;
  (primary.props.onClick as () => void)();
}
afterEach(() => {
  vi.restoreAllMocks();
  h.effects = [];
});

it.each(["rejected", "resolved"])(
  "old same-key owner %s setter cannot change successor confirmation/error",
  async (outcome) => {
    let owner = seed();
    const old = owner;
    const render = view();
    vi.spyOn(threads, "thread").mockImplementation(() => owner);
    const pending: { resolve: () => void; reject: (error: Error) => void }[] =
      [];
    vi.spyOn(threads, "setConfig").mockImplementation(
      () =>
        new Promise<void>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
    );
    choose(render(old), "Ask");
    apply(render(old));
    owner = seed();
    render(owner);
    choose(render(owner), "Read");
    apply(render(owner));
    expect(pending).toHaveLength(2);
    if (outcome === "rejected")
      pending[0].reject(new Error("obsolete confirmation error"));
    else {
      owner.permissionState = "changing";
      pending[0].resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
    const tree = render(owner);
    const dialog = tree.find((item) => item.type === WorkspaceDialog);
    expect(dialog).toBeDefined();
    expect(text(dialog?.props.children as ReactNode)).toContain("Read");
    expect(text(dialog?.props.children as ReactNode)).not.toContain(
      "obsolete confirmation error",
    );
    expect(text(dialog?.props.children as ReactNode)).not.toContain(
      "未能确认权限",
    );
    owner.permissionState = "ready";
    pending[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(render(owner).some((item) => item.type === WorkspaceDialog)).toBe(
      false,
    );
  },
);

it("confirmed future choice is presented as next message while missing facts infer no application time", () => {
  const s = seed();
  const render = view();
  vi.spyOn(threads, "thread").mockImplementation(() => s);
  let tree = render(s);
  let popover = tree.find((item) => item.type === WorkspacePopover)!;
  let menu = (popover.props.children as (close: () => void) => ReactNode)(
    () => {},
  );
  expect(text(menu)).toContain("下次消息");
  expect(text(menu)).toContain("当前完整权限尚无法确认");
  delete s.permissionEffect;
  tree = render(s);
  popover = tree.find((item) => item.type === WorkspacePopover)!;
  menu = (popover.props.children as (close: () => void) => ReactNode)(() => {});
  expect(text(menu)).toContain("已选择");
  expect(text(menu)).not.toContain("下一次普通消息将使用此选择");
});

it.each(["rejected", "resolved"])(
  "closing and reopening a review keeps the earlier %s action from affecting the new choice",
  async (outcome) => {
    const owner = seed(),
      render = view();
    vi.spyOn(threads, "thread").mockImplementation(() => owner);
    const pending: { resolve: () => void; reject: (error: Error) => void }[] =
      [];
    vi.spyOn(threads, "setConfig").mockImplementation(
      () =>
        new Promise<void>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
    );
    choose(render(owner), "Ask");
    apply(render(owner));
    const oldDialog = render(owner).find(
      (item) => item.type === WorkspaceDialog,
    )!;
    (oldDialog.props.onClose as () => void)();
    choose(render(owner), "Read");
    apply(render(owner));
    expect(pending).toHaveLength(2);
    if (outcome === "rejected")
      pending[0].reject(new Error("old choice rejected"));
    else pending[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    const dialog = render(owner).find((item) => item.type === WorkspaceDialog)!;
    expect(text(dialog.props.children as ReactNode)).toContain("Read");
    expect(text(dialog.props.children as ReactNode)).not.toContain(
      "未能确认权限",
    );
    pending[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(render(owner).some((item) => item.type === WorkspaceDialog)).toBe(
      false,
    );
  },
);

it("an old confirmation callback cannot start a setter on a replacement owner before rerender", () => {
  let owner = seed();
  const render = view();
  vi.spyOn(threads, "thread").mockImplementation(() => owner);
  const setter = vi.spyOn(threads, "setConfig").mockResolvedValue();
  choose(render(owner), "Ask");
  const oldTree = render(owner);
  owner = seed();
  apply(oldTree);
  expect(setter).not.toHaveBeenCalled();
});
