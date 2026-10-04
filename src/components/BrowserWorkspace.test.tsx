import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { BrowserWorkspaceClient } from "../runtime/browser_workspace";

const h = vi.hoisted(() => ({
  stateCursor: 0,
  refCursor: 0,
  effectCursor: 0,
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  host: {
    getBoundingClientRect: () => ({ x: 600, y: 200, width: 400, height: 500 }),
  },
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const effect = (callback: () => (() => void) | void, deps: unknown[]) => {
    const index = h.effectCursor++;
    const previous = h.effects[index];
    if (
      !previous ||
      deps.some((value, i) => !Object.is(value, previous.deps[i]))
    ) {
      const next = { deps } as typeof previous;
      h.effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = callback() || undefined;
      });
    }
  };
  return {
    ...actual,
    useId: () => "test-address",
    useState: (initial: unknown) => {
      const index = h.stateCursor++;
      if (index >= h.states.length) h.states[index] = initial;
      return [
        h.states[index],
        (next: unknown) => {
          h.states[index] =
            typeof next === "function" ? next(h.states[index]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = h.refCursor++;
      return (h.refs[index] ??= { current: index === 0 ? h.host : initial });
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

import { BrowserWorkspace } from "./BrowserWorkspace";
import { BrowserSurfaceGuard } from "../runtime/browser_surface_guard";

function client(): BrowserWorkspaceClient {
  const state = {
    taskKey: "task-a",
    label: "page-a",
    revision: 1,
    phase: "ready" as const,
    url: "https://example.com/private-title",
  };
  return {
    open: vi.fn(async () => state),
    navigate: vi.fn(async () => state),
    resize: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({
      ...state,
      title: "Old task title",
      text: "Old task content",
      observedAtMs: 1,
    })),
    close: vi.fn(async () => {}),
    listenState: vi.fn(async () => () => {}),
  };
}

function render(props: Parameters<typeof BrowserWorkspace>[0], flush = true) {
  h.stateCursor = h.refCursor = h.effectCursor = 0;
  const tree = BrowserWorkspace(props);
  const html = renderToStaticMarkup(tree);
  if (flush) for (const effect of h.pending.splice(0)) effect();
  return { tree, html };
}

function find(
  tree: unknown,
  predicate: (node: ReactElement<Record<string, any>>) => boolean,
): ReactElement<Record<string, any>> {
  if (!tree || typeof tree !== "object") throw new Error("Element not found");
  const element = tree as ReactElement<Record<string, any>>;
  if (predicate(element)) return element;
  for (const child of [element.props?.children].flat(Infinity)) {
    try {
      return find(child, predicate);
    } catch {
      /* Continue through siblings. */
    }
  }
  throw new Error("Element not found");
}

beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.effects = [];
  h.pending = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  for (const effect of h.effects) effect.cleanup?.();
  vi.unstubAllGlobals();
});

it("does not open or read a page on mount, and renders the unshared boundary", async () => {
  const backend = client();
  const { html } = render({
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  });
  expect(html).toContain("未向 Agent 分享");
  expect(html).toContain("请勿登录");
  expect(backend.open).not.toHaveBeenCalled();
  expect(backend.snapshot).not.toHaveBeenCalled();
});

it("suppresses old address and snapshot on the first render of a different task", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/private-title" },
  });
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  view = render(props);
  find(
    view.tree,
    (node) => node.type === "button" && node.props.children === "读取文字快照",
  ).props.onClick();
  await vi.waitFor(() => expect(backend.snapshot).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(render(props).html).toContain("Old task content"),
  );
  const switched = render({ ...props, taskKey: "task-b" }, false);
  expect(switched.html).not.toContain("Old task content");
  expect(switched.html).not.toContain("Old task title");
  expect(switched.html).not.toContain("private-title");
  for (const effect of h.pending.splice(0)) effect();
  await vi.waitFor(() =>
    expect(backend.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
    }),
  );
});

it("reports a failed hidden-pane closure with an exact-owner retry", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard,
  };
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  vi.mocked(backend.close).mockRejectedValueOnce(new Error("close failed"));
  expect(render({ ...props, active: false }).html).toBe("");
  await vi.waitFor(() => expect(guard.getSnapshot().failed).toBe(true));
  guard.retry();
  await vi.waitFor(() => expect(guard.getSnapshot().failed).toBe(false));
  expect(backend.close).toHaveBeenLastCalledWith({
    taskKey: "task-a",
    label: "page-a",
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("registers an in-flight open before navigation and waits for its exact close ACK", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const opened =
    deferred<Awaited<ReturnType<BrowserWorkspaceClient["open"]>>>();
  const closed = deferred<void>();
  vi.mocked(backend.open).mockReturnValue(opened.promise);
  vi.mocked(backend.close).mockReturnValue(closed.promise);
  const props = { taskKey: "task-a", active: true, client: backend, guard };
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  const navigate = vi.fn();
  guard.runLatest(navigate);
  expect(navigate).not.toHaveBeenCalled();
  opened.resolve({
    taskKey: "task-a",
    label: "late-page",
    revision: 1,
    phase: "ready",
    url: "https://example.com/",
  });
  await vi.waitFor(() =>
    expect(backend.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "late-page",
    }),
  );
  expect(navigate).not.toHaveBeenCalled();
  closed.resolve();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
});

it("keeps a covering panel pending on close failure, then blocks a new open while it is shown", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = { taskKey: "task-a", active: true, client: backend, guard };
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  vi.mocked(backend.close).mockRejectedValueOnce(
    new Error("fixture close failure"),
  );
  const cover = guard.hold();
  await vi.waitFor(() => expect(guard.getSnapshot().failed).toBe(true));
  expect(cover.ready).toBe(false);
  guard.retry();
  await vi.waitFor(() => expect(cover.ready).toBe(true));
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  expect(backend.open).toHaveBeenCalledOnce();
  cover.release();
});

it("offers a working local close retry after the first close fails", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = { taskKey: "task-a", active: true, client: backend, guard };
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  vi.mocked(backend.close).mockRejectedValueOnce(new Error("fixture"));
  view = render(props);
  find(
    view.tree,
    (node) => node.type === "button" && node.props.children === "关闭网页",
  ).props.onClick();
  await vi.waitFor(() => expect(guard.getSnapshot().failed).toBe(true));
  view = render(props);
  find(
    view.tree,
    (node) => node.type === "button" && node.props.children === "重试关闭",
  ).props.onClick();
  await vi.waitFor(() => expect(backend.close).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(guard.getSnapshot().busy).toBe(false));
  expect(guard.getSnapshot().failed).toBe(false);
});
