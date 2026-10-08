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
import { draftPersistence } from "../runtime/draft_storage";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
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
    (node) => node.props["aria-label"] === "命令与模板",
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
      node.type === "button" && node.props["aria-label"] === "添加文件或图片",
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

it.each(["draft", "established"] as const)(
  "inserts only declared Agent commands in a %s conversation and preserves input on cancellation",
  (identity) => {
    const before = composerDrafts.read("session:shortcut-a");
    const queued = props.thread!.queued;
    props.thread!.identity = identity;
    // File add stays in the + menu; commands/templates live in one ⌘ entry.
    const addMenu = openAdd();
    expect(
      addMenu.some(
        (node) =>
          node.type === WorkspaceActionMenu &&
          node.props.title === "添加到这段对话",
      ),
    ).toBe(true);
    expect(buttonNamed("Agent 命令")).toBeUndefined();
    expect(plusFocus).toHaveBeenCalled();
    const tree = open();
    expect(
      tree.some(
        (node) =>
          node.type === WorkspaceActionMenu &&
          node.props.title === "命令与模板",
      ),
    ).toBe(true);
    expect(tree.some((node) => node.type === WorkspaceDialog)).toBe(false);
    expect(
      render().some(
        (node) => node.props.children === "这个 Agent 暂未提供命令。",
      ),
    ).toBe(true);
    expect(buttonNamed("/compact")).toBeUndefined();
    // Templates share the same panel as Agent commands.
    expect(shortcut("先给出计划")).toBeDefined();
    applyUpdate(props.thread!, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "official", description: "Agent command" }],
    });
    const command = buttonNamed("/official");
    expect(command).toBeDefined();
    (command!.props.onClick as () => void)();
    expect(composerDrafts.read("session:shortcut-a").text).toBe(
      `/official ${before.text}`,
    );
    expect(composerDrafts.read("session:shortcut-a").attachments).toBe(
      before.attachments,
    );
    expect(props.thread!.queued).toBe(queued);
    expect(threads.send).not.toHaveBeenCalled();
    const reopened = open().find((node) => node.type === WorkspaceActionMenu)!;
    (reopened.props.onClose as () => void)();
    expect(render().some((node) => node.type === WorkspaceDialog)).toBe(false);
    expect(composerDrafts.read("session:shortcut-a").text).toBe(
      `/official ${before.text}`,
    );
    expect(composerDrafts.read("session:shortcut-a").attachments).toBe(
      before.attachments,
    );
    expect(props.thread!.queued).toBe(queued);
    expect(threads.send).not.toHaveBeenCalled();
  },
);
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

it("dismisses slash suggestions with Escape without changing the draft and reopens them after editing", () => {
  props.thread!.availableCommands = [
    { name: "official", description: "Official command" },
  ];
  composerDrafts.update("session:shortcut-a", (draft) => ({
    ...draft,
    text: "/off",
  }));
  const before = composerDrafts.read("session:shortcut-a");
  const queued = props.thread!.queued;
  const tree = render();
  expect(tree.some((node) => node.props.role === "option")).toBe(true);
  const event = {
    key: "Escape",
    nativeEvent: { isComposing: false, keyCode: 27 },
    preventDefault: vi.fn(),
  };
  const area = tree.find((node) => node.type === "textarea")!;
  (area.props.onKeyDown as (event: unknown) => void)(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(render().some((node) => node.props.role === "listbox")).toBe(false);
  expect(composerDrafts.read("session:shortcut-a")).toBe(before);
  expect(props.thread!.queued).toBe(queued);
  expect(threads.send).not.toHaveBeenCalled();
  (area.props.onChange as (event: unknown) => void)({
    target: { value: "/offi" },
  });
  expect(render().some((node) => node.props.role === "option")).toBe(true);
  expect(composerDrafts.read("session:shortcut-a").attachments).toBe(
    before.attachments,
  );
});

it("keeps Tab navigation and normal Enter dispatch when a slash token has no visible match", async () => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  props.thread!.availableCommands = [{ name: "official" }];
  composerDrafts.update("session:shortcut-a", (draft) => ({
    ...draft,
    text: "/unlisted",
  }));
  const before = composerDrafts.read("session:shortcut-a");
  const tree = render();
  expect(tree.some((node) => node.props.role === "listbox")).toBe(false);
  const area = tree.find((node) => node.type === "textarea")!;
  const key = (value: string) => ({
    key: value,
    nativeEvent: { isComposing: false, keyCode: value === "Enter" ? 13 : 9 },
    preventDefault: vi.fn(),
  });
  const tab = key("Tab");
  (area.props.onKeyDown as (event: unknown) => void)(tab);
  expect(tab.preventDefault).not.toHaveBeenCalled();
  expect(composerDrafts.read("session:shortcut-a")).toBe(before);
  expect(threads.send).not.toHaveBeenCalled();
  const enter = key("Enter");
  (area.props.onKeyDown as (event: unknown) => void)(enter);
  await vi.waitFor(() => expect(threads.send).toHaveBeenCalledOnce());
  expect(enter.preventDefault).toHaveBeenCalledOnce();
  expect(threads.send).toHaveBeenCalledWith("shortcut-a", [
    { type: "text", text: "/unlisted" },
    { type: "resource_link", name: "notes.md", uri: "file:///p/notes.md" },
  ]);
});

it("shows the declared command input hint only while its argument is empty, without inserting or sending it", () => {
  const hint = "Describe the files to review";
  applyUpdate(props.thread!, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "official", description: "Review", input: { hint } },
    ],
  });
  composerDrafts.update("session:shortcut-a", (draft) => ({
    ...draft,
    text: "/official ",
  }));
  const before = composerDrafts.read("session:shortcut-a");
  const tree = render();
  const area = tree.find((node) => node.type === "textarea")!;
  expect(area.props["aria-description"]).toBe(hint);
  expect(
    tree.some((node) => node.type === "p" && node.props.children === hint),
  ).toBe(true);
  expect(composerDrafts.read("session:shortcut-a")).toBe(before);
  expect(threads.send).not.toHaveBeenCalled();
  (area.props.onChange as (event: unknown) => void)({
    target: { value: "/official notes.md" },
  });
  expect(render().some((node) => node.props.children === hint)).toBe(false);
  expect(composerDrafts.read("session:shortcut-a").attachments).toBe(
    before.attachments,
  );
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

it("keeps the unified entry on opened drafts but off the pre-open and queue-edit composer", () => {
  props.thread = null;
  expect(
    render().some((node) => node.props["aria-label"] === "命令与模板"),
  ).toBe(false);
  // An opened draft already has a live session — its commands stay reachable.
  props.thread = freshThreadState("shortcut-draft", "test", "/p", "two");
  props.thread.identity = "draft";
  expect(
    render().some((node) => node.props["aria-label"] === "命令与模板"),
  ).toBe(true);
  props.thread.identity = "established";
  props.queueEditing = true;
  expect(
    render().some((node) => node.props["aria-label"] === "命令与模板"),
  ).toBe(false);
});
