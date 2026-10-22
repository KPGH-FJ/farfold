import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  cleanup: undefined as undefined | (() => void),
  current: undefined as unknown,
  stop: vi.fn(),
  show: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) =>
    h.slots[h.cursor++] ?? (h.slots[h.cursor - 1] = { current: value }),
  useEffect: (effect: () => void | (() => void)) => {
    h.cleanup = effect() || undefined;
  },
}));
vi.mock("../runtime/sessions", () => ({
  threads: { thread: () => h.current, stopTask: h.stop },
}));
import { AsyncTasks } from "./AsyncTasks";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
import { receiveAsyncTasks } from "../runtime/async_tasks";
import { ASYNC_TASKS as T } from "../runtime/async_task_strings";
import type { ThreadState } from "../runtime/session_types";
let thread: ThreadState;
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const all: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node)) {
      all.push(node);
      all.push(...nodes(node.props.children as ReactNode));
    }
  });
  return all;
}
function render(active = true) {
  h.cursor = 0;
  const tree = AsyncTasks({ thread, active, onShowTool: h.show });
  return {
    html: renderToStaticMarkup(tree),
    buttons: nodes(tree).filter((e) => e.type === "button"),
  };
}
const click = (node: ReactElement<Record<string, unknown>>) =>
  (node.props.onClick as () => void)();
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.cleanup = undefined;
  h.stop.mockReset();
  h.show.mockReset();
  thread = freshThreadState("view", "agent", "/own", "native");
  thread.connectionId = "conn";
  h.current = thread;
  receiveAsyncTasks(thread, {
    kind: "asyncTasks",
    connectionId: "conn",
    sessionId: "native",
    supported: true,
    overflow: false,
    tasks: [
      {
        asyncTaskId: "task",
        name: "A <script>name</script>",
        taskType: "shell",
        toolCallId: null,
        canStop: true,
        state: "running",
        stopRequest: "idle",
      },
    ],
  });
});
it("shows generic exact task control, escapes reported name and dispatches only on explicit click", () => {
  const { html, buttons } = render();
  expect(html).toContain(T.title);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(h.stop).not.toHaveBeenCalled();
  click(buttons[0]);
  expect(h.stop).toHaveBeenCalledExactlyOnceWith(
    thread.key,
    thread.asyncTasks!.tasks[0],
  );
});
it.each(["hide", "replace", "unmount"])(
  "rejects old button after %s",
  (mode) => {
    const old = render().buttons[0];
    if (mode === "hide") render(false);
    else if (mode === "replace") {
      thread = { ...thread };
      h.current = thread;
      render();
    } else h.cleanup!();
    click(old);
    expect(h.stop).not.toHaveBeenCalled();
  },
);
it("keeps accepted stop waiting and disables repeated click until actual terminal", () => {
  thread.asyncTasks!.tasks[0].stopRequest = "accepted";
  const waiting = render();
  expect(waiting.html).toContain(T.accepted);
  expect(waiting.buttons[0].props.disabled).toBe(true);
  thread.asyncTasks!.tasks[0].state = "completed";
  const done = render();
  expect(done.html).toContain(T.completed);
  expect(done.html).not.toContain(T.stopped);
  expect(done.buttons).toHaveLength(0);
});
it("shows unavailable after connection loss without claiming stopped", () => {
  thread.connectionLost = true;
  const view = render();
  expect(view.html).toContain(T.disconnected);
  expect(view.buttons[0].props.disabled).toBe(true);
  expect(view.html).not.toContain(T.stopped);
});
it("does not expose unsupported controls", () => {
  thread.asyncTasks!.supported = false;
  expect(render().html).toBe("");
});
it("does not automatically collapse the details when the requested task finishes", () => {
  thread.asyncTasks!.tasks[0].state = "completed";
  expect(render().html).toContain('<details open="">');
});

function addSource() {
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "source-tool",
    title: "Reported source",
    kind: "execute",
    status: "in_progress",
  });
  thread.asyncTasks!.tasks[0].toolCallId = "source-tool";
  return thread.items.find((item) => item.kind === "tool")!;
}
it("locates the exact reported source independently of task stop or completion", () => {
  const source = addSource();
  thread.asyncTasks!.tasks[0].state = "completed";
  const view = render();
  expect(view.html).toContain(T.source);
  expect(h.show).not.toHaveBeenCalled();
  click(view.buttons[0]);
  expect(h.show).toHaveBeenCalledExactlyOnceWith(source);
  expect(h.stop).not.toHaveBeenCalled();
});
it.each(["missing", "ambiguous", "connection", "session"])(
  "does not substitute another source when %s",
  (mode) => {
    const source = addSource();
    if (mode === "missing") thread.items = [];
    if (mode === "ambiguous") thread.items.push({ ...source, id: "other" });
    if (mode === "connection") thread.connectionId = "another";
    if (mode === "session") thread.nativeSessionId = "another";
    const view = render();
    expect(view.html).toContain(T.sourceUnavailable);
    expect(
      view.buttons.some((button) => button.props.children === T.source),
    ).toBe(false);
    expect(h.show).not.toHaveBeenCalled();
  },
);
it.each(["hide", "replace", "unmount", "removed", "ambiguous"])(
  "rejects a stale source action after %s",
  (mode) => {
    const source = addSource();
    const old = render().buttons[0];
    if (mode === "hide") render(false);
    if (mode === "replace") {
      thread = { ...thread };
      h.current = thread;
      render();
    }
    if (mode === "unmount") h.cleanup!();
    if (mode === "removed") thread.items = [];
    if (mode === "ambiguous") thread.items.push({ ...source, id: "other" });
    click(old);
    expect(h.show).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
  },
);
