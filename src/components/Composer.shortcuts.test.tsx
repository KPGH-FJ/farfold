// These existing hook fixtures have no native browser; the barrier has dedicated lifecycle tests.
vi.mock("../runtime/browser_surface", async (original) => ({
  ...(await original<typeof import("../runtime/browser_surface")>()),
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { Composer } from "./Composer";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { composerDrafts } from "../runtime/drafts";
import { freshThreadState } from "../runtime/session_projection";
import { threads } from "../runtime/sessions";

type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof Composer>;
const focus = vi.fn();
const plusFocus = vi.fn();
function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function render() {
  for (let pass = 0; pass < 8; pass++) {
    h.cursor = 0;
    const tree = nodes(Composer(props));
    for (const node of tree) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (ref)
        ref.current =
          node.type === "textarea"
            ? { focus, style: {}, scrollHeight: 48 }
            : { focus: plusFocus };
    }
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("Unexpected render loop");
}
function open() {
  const trigger = render().find(
    (node) => node.props["aria-label"] === "快捷指令",
  );
  expect(trigger).toBeDefined();
  (trigger!.props.onClick as () => void)();
  return render();
}
function shortcut(label: string) {
  return render().find(
    (node) =>
      node.type === "button" &&
      nodes(node.props.children as ReactNode).some(
        (child) => child.props.children === label,
      ),
  )!;
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  focus.mockClear();
  plusFocus.mockClear();
  const thread = freshThreadState("shortcut-a", "test", "/p", "one");
  thread.identity = "established";
  thread.running = true;
  thread.queued = [[{ type: "text", text: "Keep queue" }]];
  props = {
    thread,
    imageEnabled: true,
    onGoSettings: vi.fn(),
    editableWhenDisabled: true,
  };
  composerDrafts.update("session:shortcut-a", () => ({
    text: "  Existing draft/",
    attachments: [
      { id: "file", kind: "file", name: "notes.md", uri: "file:///p/notes.md" },
    ],
  }));
  vi.spyOn(threads, "send").mockResolvedValue({ status: "queued" });
});

function openAdd() {
  const trigger = render().find(
    (node) =>
      node.type === "button" &&
      node.props["aria-expanded"] !== undefined &&
      node.props["aria-label"] !== "快捷指令",
  )!;
  (trigger.props.onClick as () => void)();
  return render();
}
function buttonNamed(label: string) {
  const text = (children: ReactNode): string =>
    Children.toArray(children)
      .map((child) =>
        isValidElement<{ children?: ReactNode }>(child)
          ? text(child.props.children)
          : String(child),
      )
      .join("");
  return render().find(
    (node) =>
      node.type === "button" &&
      (text(node.props.children as ReactNode) === label ||
        nodes(node.props.children as ReactNode).some(
          (child) => text(child.props.children as ReactNode) === label,
        )),
  );
}
it("exposes project-file lookup through the add menu and keeps existing input", () => {
  const before = composerDrafts.read("session:shortcut-a");
  openAdd();
  const find = buttonNamed("查找项目文件");
  expect(find).toBeDefined();
  (find!.props.onClick as () => void)();
  expect(composerDrafts.read("session:shortcut-a").text).toBe(
    `${before.text} @`,
  );
  expect(composerDrafts.read("session:shortcut-a").attachments).toBe(
    before.attachments,
  );
  expect(focus).toHaveBeenCalled();
  expect(threads.send).not.toHaveBeenCalled();
});

it("uses a new-draft add dialog with only real Agent commands and preserves input on cancellation", () => {
  props.thread!.identity = "draft";
  const tree = openAdd();
  expect(
    tree.some(
      (node) =>
        node.type === WorkspaceDialog && node.props.title === "添加到这段对话",
    ),
  ).toBe(true);
  expect(plusFocus).toHaveBeenCalled();
  const commands = buttonNamed("Agent 命令");
  expect(commands).toBeDefined();
  (commands!.props.onClick as () => void)();
  expect(
    render().some(
      (node) => node.props.children === "这个 Agent 暂未提供命令。",
    ),
  ).toBe(true);
  expect(buttonNamed("/compact")).toBeUndefined();
  props.thread!.availableCommands = [
    { name: "official", description: "Agent command" },
  ];
  const command = buttonNamed("/official");
  expect(command).toBeDefined();
  (command!.props.onClick as () => void)();
  expect(composerDrafts.read("session:shortcut-a").text).toBe("/official ");
  expect(threads.send).not.toHaveBeenCalled();
  const reopened = openAdd().find((node) => node.type === WorkspaceDialog)!;
  (reopened.props.onClose as () => void)();
  expect(render().some((node) => node.type === WorkspaceDialog)).toBe(false);
  expect(composerDrafts.read("session:shortcut-a").text).toBe("/official ");
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  composerDrafts.clear("session:shortcut-a");
  composerDrafts.clear("session:shortcut-b");
  vi.restoreAllMocks();
});

it.each([
  ["先给出计划", "先给出一个可讨论的计划，确认后再继续。"],
  ["整理为要点", "请把上面的内容整理成简洁要点。"],
  ["换一种表达", "保留原意，换一种更自然、简洁的表达。"],
])(
  "appends %s to the current editable draft without sending or altering attachments and queue",
  (label, appended) => {
    const before = composerDrafts.read("session:shortcut-a");
    const queued = props.thread!.queued;
    open();
    (shortcut(label).props.onClick as () => void)();
    const after = composerDrafts.read("session:shortcut-a");
    expect(after.text).toBe(`${before.text}\n${appended}`);
    expect(after.attachments).toBe(before.attachments);
    expect(props.thread!.queued).toBe(queued);
    expect(threads.send).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
    expect(render().some((node) => node.type === WorkspaceActionMenu)).toBe(
      false,
    );
  },
);

it("keeps native Agent slash commands available after canceling the local menu", () => {
  props.thread!.availableCommands = [
    { name: "official", description: "Official command" },
  ];
  composerDrafts.update("session:shortcut-a", (draft) => ({
    ...draft,
    text: "/off",
  }));
  expect(render().some((node) => node.props.role === "option")).toBe(true);
  const tree = open();
  expect(tree.some((node) => node.props.role === "option")).toBe(false);
  const menu = tree.find((node) => node.type === WorkspaceActionMenu)!;
  (menu.props.onClose as () => void)();
  expect(render().some((node) => node.props.role === "option")).toBe(true);
  expect(composerDrafts.read("session:shortcut-a").text).toBe("/off");
  expect(threads.send).not.toHaveBeenCalled();
});

it("closes on navigation and rejects an old menu action after changing conversations", () => {
  open();
  const stale = shortcut("先给出计划").props.onClick as () => void;
  props = { ...props, active: false };
  expect(render().some((node) => node.type === WorkspaceActionMenu)).toBe(
    false,
  );
  stale();
  expect(composerDrafts.read("session:shortcut-a").text).toBe(
    "  Existing draft/",
  );
  props = { ...props, active: true };
  expect(render().some((node) => node.type === WorkspaceActionMenu)).toBe(
    false,
  );
  open();
  const prior = shortcut("先给出计划").props.onClick as () => void;
  props.thread = { ...props.thread!, key: "shortcut-b" };
  render();
  prior();
  expect(composerDrafts.read("session:shortcut-a").text).toBe(
    "  Existing draft/",
  );
  expect(composerDrafts.read("session:shortcut-b").text).toBe("");
  expect(threads.send).not.toHaveBeenCalled();
});

it("contains shortcut keyboard events so they cannot reach conversation approval shortcuts", () => {
  const tree = open();
  const host = tree.find((node) => node.props.className === "composer")!;
  for (const key of ["Enter", "Backspace", "Escape", "Tab"]) {
    const event = { key, stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (host.props.onKeyDown as (event: unknown) => void)(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
  (
    tree.find((node) => node.type === WorkspaceActionMenu)!.props
      .onClose as () => void
  )();
  const closed = render().find((node) => node.props.className === "composer")!;
  const event = { key: "Enter", stopPropagation: vi.fn() };
  (closed.props.onKeyDown as (event: unknown) => void)(event);
  expect(event.stopPropagation).not.toHaveBeenCalled();
});

it("does not offer local conversation shortcuts on the new-draft or queue-edit composer", () => {
  props.thread!.identity = "draft";
  expect(render().some((node) => node.props["aria-label"] === "快捷指令")).toBe(
    false,
  );
  props.thread!.identity = "established";
  props.queueEditing = true;
  expect(render().some((node) => node.props["aria-label"] === "快捷指令")).toBe(
    false,
  );
});
