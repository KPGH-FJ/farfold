import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
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
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [slot.value, (next: unknown) => (slot.value = next)];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useMemo: (read: () => unknown) => read(),
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
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { ThreadView } from "./ThreadView";
import { MessageCopyButton, ToolStep } from "./thread-items";
import { freshThreadState } from "../runtime/session_projection";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";

type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
let thread: ReturnType<typeof freshThreadState>;
let scroll: { scrollTop: number; scrollHeight: number; clientHeight: number };
function render(active = true) {
  h.cursor = 0;
  const tree = nodes(
    ThreadView({
      thread,
      active,
      agents: [],
      onGoSettings: () => {},
      onOpened: () => {},
    }),
  );
  const transcript = tree.find(
    (node) => node.props.className === "transcript",
  )!;
  (transcript.props.ref as { current: unknown }).current = scroll;
  for (const effect of h.effects.splice(0)) effect();
  return {
    tree,
    onScroll: transcript.props.onScroll as () => void,
    latest: tree.find((node) => node.props.className === "workspace-latest"),
  };
}
function renderCopy(text: string) {
  h.cursor = 0;
  const tree = nodes(MessageCopyButton({ text }));
  for (const effect of h.effects.splice(0)) effect();
  return {
    click: tree.find((node) => node.type === "button")!.props
      .onClick as () => void,
    status: tree.find((node) => node.props.role === "status")?.props.children,
  };
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  thread = freshThreadState("reading", "a", "/p", "history");
  scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ["read", "读取"],
  ["edit", "修改"],
  ["delete", "删除"],
  ["move", "移动"],
  ["search", "搜索"],
  ["execute", "执行"],
  ["think", "思考"],
  ["fetch", "获取"],
  ["switch_mode", "切换模式"],
  ["other", "其他操作"],
  ["custom_check", "其他操作（custom_check）"],
])(
  "labels %s in Chinese without changing the actual tool title",
  (kind, expected) => {
    h.cursor = 0;
    const tree = nodes(
      ToolStep({
        call: {
          toolCallId: "step",
          title: "Actual Agent title",
          kind,
          status: "completed",
          locations: [],
          content: [],
          startedAt: 0,
        },
      }),
    );
    const label = tree.find((node) => node.props.className === "cmd")!;
    expect((label.props.children as ReactNode[])[0]).toBe(expected);
    expect(
      tree.some(
        (node) =>
          node.type === "b" && node.props.children === "Actual Agent title",
      ),
    ).toBe(true);
  },
);

it("preserves a reader's position during new replies and resumes following only after returning to latest", () => {
  expect(render().latest).toBeUndefined();
  expect(scroll.scrollTop).toBe(1000);
  scroll.scrollTop = 100;
  render().onScroll();
  expect(render().latest).toBeDefined();
  thread.items.push({
    kind: "agent",
    id: "reply",
    text: "New text",
    streaming: true,
    time: 1,
  });
  scroll.scrollHeight = 1200;
  const view = render();
  expect(scroll.scrollTop).toBe(100);
  (view.latest!.props.onClick as () => void)();
  expect(scroll.scrollTop).toBe(1200);
  expect(render().latest).toBeUndefined();
  thread.items[0] = {
    kind: "agent",
    id: "reply",
    text: "New text continues",
    streaming: true,
    time: 1,
  };
  scroll.scrollHeight = 1400;
  render();
  expect(scroll.scrollTop).toBe(1400);
});

it("hides the return action after manual scrolling to the bottom", () => {
  render();
  scroll.scrollTop = 100;
  render().onScroll();
  expect(render().latest).toBeDefined();
  scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
  render().onScroll();
  expect(render().latest).toBeUndefined();
});

it("does not move a hidden conversation even through a previously captured return action", () => {
  render();
  scroll.scrollTop = 100;
  render().onScroll();
  const staleClick = render().latest!.props.onClick as () => void;
  expect(render(false).latest).toBeUndefined();
  scroll.scrollHeight = 1400;
  staleClick();
  expect(scroll.scrollTop).toBe(100);
  expect(render().latest).toBeDefined();
  expect(scroll.scrollTop).toBe(100);
});

it("provides each user and restored Agent message's own text to its copy action", () => {
  thread.items = [
    {
      kind: "user",
      id: "user",
      text: "Current user\nmessage",
      attachments: [],
      streaming: false,
      time: 1,
    },
    {
      kind: "user",
      id: "old-user",
      text: "Earlier question",
      attachments: [],
      streaming: false,
      time: 0,
    },
    {
      kind: "agent",
      id: "old-agent",
      text: "Earlier **answer**",
      streaming: false,
      time: 0,
    },
    {
      kind: "user",
      id: "image-only",
      text: "",
      attachments: [],
      streaming: false,
      time: 1,
    },
  ];
  expect(
    render()
      .tree.filter((node) => node.type === MessageCopyButton)
      .map((node) => node.props.text),
  ).toEqual([
    "Current user\nmessage",
    "Earlier question",
    "Earlier **answer**",
  ]);
});

it("copies exact message text and acknowledges only a successful clipboard write", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const text = "  Full message\n**with formatting**\n";
  const view = renderCopy(text);
  view.click();
  expect(renderCopy(text).status).toBeUndefined();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  expect(renderCopy(text).status).toBe(T.copied);
});

it("reports a clipboard failure and allows a later retry", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCopy("Message").click();
  await Promise.resolve();
  expect(renderCopy("Message").status).toBe(T.copyFailed);
  renderCopy("Message").click();
  await Promise.resolve();
  expect(renderCopy("Message").status).toBe(T.copied);
});

it("ignores a late clipboard result after the displayed text has changed", async () => {
  let finish!: () => void;
  const writeText = vi.fn(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  renderCopy("Earlier text").click();
  renderCopy("Later text");
  finish();
  await Promise.resolve();
  expect(renderCopy("Later text").status).toBeUndefined();
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Earlier text");
});
