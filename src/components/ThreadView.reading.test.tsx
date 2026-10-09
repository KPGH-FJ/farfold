import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  browserPending: false,
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
  // Direct-call reading tests run outside the search provider.
  useContext: () => false,
  useMemo: (read: () => unknown) => read(),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
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
// These tests invoke ThreadView with a minimal hook harness; browser permissions
// have their own controller/component tests and are absent from these scenarios.
vi.mock("../runtime/browser_sharing", async (original) => {
  const actual = await original<typeof import("../runtime/browser_sharing")>();
  const noop = async () => {};
  const empty: import("../runtime/browser_sharing").BrowserSharingModel = {
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: noop,
    allow: noop,
    stop: noop,
    respond: noop,
  };
  return {
    ...actual,
    useBrowserSharing: () => ({
      ...empty,
      pendingRequest: h.browserPending
        ? {
            requestId: "read:synthetic",
            taskKey: "reading",
            label: "page",
            url: "https://example.org/",
            pageRevision: 1,
            phase: "awaiting_permission" as const,
          }
        : null,
    }),
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { ThreadView } from "./ThreadView";
import { ArtifactPane } from "./ArtifactPane";
import { threads } from "../runtime/sessions";
import { MessageCopyButton, RawBlock, ToolStep } from "./thread-items";
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
  h.browserPending = false;
  h.effects = [];
  thread = freshThreadState("reading", "a", "/p", "history");
  scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const textContent = (tree: ReactNode): string => {
  let out = "";
  const visit = (node: ReactNode) => {
    if (node == null || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      out += node;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isValidElement<Record<string, unknown>>(node))
      visit(node.props.children as ReactNode);
  };
  visit(tree);
  return out;
};

it.each([
  ["read", "查看了文件", "读取"],
  ["edit", "修改了文件", "修改"],
  ["delete", "删除了文件", "删除"],
  ["move", "移动了文件", "移动"],
  ["search", "搜索了内容", "搜索"],
  ["execute", "运行了命令", "执行"],
  ["think", "思考了", "思考"],
  ["fetch", "查看了网页", "获取"],
  ["switch_mode", "切换了模式", "切换模式"],
  ["other", "执行了操作", "其他操作"],
  ["custom_check", "执行了操作", "其他操作（custom_check）"],
])(
  "summarizes %s in user language while the raw kind and title stay in technical details",
  (kind, summary, detailKind) => {
    const call = {
      toolCallId: "step",
      title: "Actual Agent title",
      kind,
      status: "completed",
      locations: [],
      content: [{ type: "text" as const, text: "output text" }],
      startedAt: 0,
    };
    h.cursor = 0;
    let tree = nodes(ToolStep({ call }));
    const label = tree.find((node) => node.props.className === "cmd")!;
    expect((label.props.children as ReactNode[])[0]).toBe(summary);
    // The collapsed primary row never shows the raw kind or Agent title.
    expect(textContent(label.props.children as ReactNode)).not.toContain(
      "Actual Agent title",
    );
    const toggle = tree.find((node) => node.props.className === "step-toggle")!;
    (toggle.props.onClick as () => void)();
    h.cursor = 0;
    tree = nodes(ToolStep({ call }));
    // ToolDetail is a component element in the unexpanded tree; render it.
    const detailHost = tree.find((node) => node.props.call === call)!;
    const detail = (
      detailHost.type as (p: unknown) => ReactElement<Record<string, unknown>>
    )(detailHost.props);
    expect(detail.props.className).toBe("step-detail");
    const detailText = textContent(detail);
    expect(detailText).toContain(detailKind);
    expect(detailText).toContain("Actual Agent title");
    expect(detailText).toContain("output text");
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

it.each(
  (["text", "attachment"] as const).flatMap((growth) =>
    (["following", "scrolled up", "hidden"] as const).map(
      (mode) => [growth, mode] as const,
    ),
  ),
)(
  "handles %s growth before transparent notifications while %s",
  (growth, mode) => {
    const reply: Extract<(typeof thread.items)[number], { kind: "agent" }> = {
      kind: "agent",
      id: "reply",
      text: "MARK",
      attachments: [],
      streaming: true,
      time: 1,
    };
    thread.items = [
      reply,
      {
        kind: "raw",
        id: "notification",
        update: { method: "_future/status" },
        label: "notification",
        streamNeutral: true,
        time: 2,
      },
    ];
    render();
    if (mode !== "following") {
      scroll.scrollTop = 100;
      render().onScroll();
    }
    render(mode !== "hidden");
    if (growth === "text") reply.text += "ER";
    else
      reply.attachments!.push({
        name: "notes",
        kind: "resource_link",
        uri: "file:///p/notes.md",
      });
    scroll.scrollHeight = 1400;
    render(mode !== "hidden");
    expect(scroll.scrollTop).toBe(mode === "following" ? 1400 : 100);
  },
);

it("provides one complete copy action when an ordinary notification interrupts a word", () => {
  thread = threads.markOpenFailed(
    "reading-notification",
    "a",
    "/p",
    "history",
    "fixture",
  );
  thread.openError = null;
  const event = (value: unknown) =>
    (
      threads as unknown as {
        applyChannelEvent: (key: string, value: unknown) => void;
      }
    ).applyChannelEvent(thread.key, value);
  for (const value of [
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "MARK" },
      },
    },
    {
      kind: "notification",
      method: "_future/status",
      params: { complete: true },
    },
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ER\n**whole answer**" },
      },
    },
  ])
    event(value);
  const tree = render().tree;
  expect(tree.filter((node) => node.type === RawBlock)).toHaveLength(1);
  const copy = tree.filter((node) => node.type === MessageCopyButton);
  expect(copy.map((node) => node.props.text)).toEqual([
    "MARKER\n**whole answer**",
  ]);
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

it("follows a new webpage request only when already following the conversation", () => {
  render();
  scroll.scrollHeight = 1300;
  h.browserPending = true;
  render();
  expect(scroll.scrollTop).toBe(1300);
  scroll.scrollTop = 100;
  render().onScroll();
  h.browserPending = false;
  render();
  h.browserPending = true;
  scroll.scrollHeight = 1600;
  render();
  expect(scroll.scrollTop).toBe(100);
});

it("explicitly returning from the webpage focuses the original request, and stale hidden actions do nothing", () => {
  h.browserPending = true;
  const close = vi
    .spyOn(threads, "closeArtifactPane")
    .mockImplementation(() => {});
  const view = render();
  const requests = view.tree.find(
    (node) => node.props.className === "workspace-requests",
  )!;
  const target = { scrollIntoView: vi.fn(), focus: vi.fn() };
  (requests.props.ref as { current: unknown }).current = target;
  expect(requests.props.tabIndex).toBe(-1);
  const pane = view.tree.find((node) => node.type === ArtifactPane)!;
  const toolbar = pane.props.browserToolbar as ReactElement<{
    onViewRequest: () => void;
  }>;
  toolbar.props.onViewRequest();
  expect(close).toHaveBeenCalledWith(thread.key);
  expect((pane.props.returnFocusRef as { current: unknown }).current).toBe(
    target,
  );
  expect(target.scrollIntoView).toHaveBeenCalled();
  expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  render(false);
  toolbar.props.onViewRequest();
  expect(close).toHaveBeenCalledTimes(1);
  expect(target.focus).toHaveBeenCalledTimes(1);
});
