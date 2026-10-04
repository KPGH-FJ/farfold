import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { BrowserWorkspaceClient } from "../runtime/browser_workspace";

const h = vi.hoisted(() => ({
  chooseFile: vi.fn(),
  inspectSelected: vi.fn(),
  inspect: vi.fn(),
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

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.chooseFile }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: { inspectSelected: h.inspectSelected, inspect: h.inspect },
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
    openHtml: vi.fn(async () => ({
      ...state,
      label: "local-a",
      url: "about:blank",
      localFileName: "game.html",
    })),
    navigate: vi.fn(async () => state),
    resize: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}),
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
  h.chooseFile.mockReset();
  h.inspectSelected.mockReset();
  h.inspect.mockReset();
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
    (node) =>
      node.type === "button" && node.props["aria-label"] === "读取文字快照",
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
    (node) => node.type === "button" && node.props["aria-label"] === "关闭网页",
  ).props.onClick();
  await vi.waitFor(() => expect(guard.getSnapshot().failed).toBe(true));
  view = render(props);
  find(
    view.tree,
    (node) => node.type === "button" && node.props["aria-label"] === "重试关闭",
  ).props.onClick();
  await vi.waitFor(() => expect(backend.close).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(guard.getSnapshot().busy).toBe(false));
  expect(guard.getSnapshot().failed).toBe(false);
});

async function openedView(props: Parameters<typeof BrowserWorkspace>[0]) {
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  await find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(props.client.open).toHaveBeenCalledOnce());
  render(props);
  await Promise.resolve();
}

it("keeps the exact page alive when collapsed and reports only actual hide ACK", async () => {
  const backend = client();
  const onVisibilityChange = vi.fn();
  const onStateChange = vi.fn();
  const props = {
    taskKey: "task-a",
    active: true,
    visible: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    onVisibilityChange,
    onStateChange,
  };
  await openedView(props);
  const hidden = deferred<void>();
  vi.mocked(backend.setVisible).mockReturnValueOnce(hidden.promise);
  onVisibilityChange.mockClear();
  render({ ...props, visible: false });
  await vi.waitFor(() =>
    expect(backend.setVisible).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
      visible: false,
    }),
  );
  expect(onVisibilityChange).not.toHaveBeenCalledWith(false);
  expect(backend.close).not.toHaveBeenCalled();
  hidden.resolve();
  await vi.waitFor(() =>
    expect(onVisibilityChange).toHaveBeenCalledWith(false),
  );
  render({ ...props, visible: true });
  await vi.waitFor(() => expect(onVisibilityChange).toHaveBeenCalledWith(true));
  expect(backend.open).toHaveBeenCalledOnce();
  expect(backend.close).not.toHaveBeenCalled();
  expect(onStateChange).toHaveBeenLastCalledWith({
    taskKey: "task-a",
    label: "page-a",
    revision: 1,
    phase: "ready",
    url: "https://example.com/private-title",
  });
  expect(JSON.stringify(onStateChange.mock.calls)).not.toContain(
    "Old task content",
  );
});

it("keeps the pane footprint after failed hide until a retried close really confirms", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const onVisibilityChange = vi.fn();
  const props = {
    taskKey: "task-a",
    active: true,
    visible: true,
    client: backend,
    guard,
    onVisibilityChange,
  };
  await openedView(props);
  vi.mocked(backend.setVisible).mockRejectedValueOnce(new Error("hide failed"));
  vi.mocked(backend.close).mockRejectedValueOnce(new Error("close failed"));
  onVisibilityChange.mockClear();
  render({ ...props, visible: false });
  await vi.waitFor(() => expect(guard.getSnapshot().failed).toBe(true));
  expect(onVisibilityChange).not.toHaveBeenCalledWith(false);
  guard.retry();
  await vi.waitFor(() =>
    expect(onVisibilityChange).toHaveBeenCalledWith(false),
  );
  expect(backend.close).toHaveBeenLastCalledWith({
    taskKey: "task-a",
    label: "page-a",
  });
});

it("reloads through navigation even for the same URL and clears an earlier snapshot", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await openedView(props);
  let view = render(props);
  find(
    view.tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "读取文字快照",
  ).props.onClick();
  await vi.waitFor(() =>
    expect(render(props).html).toContain("Old task content"),
  );
  view = render(props);
  find(
    view.tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "重新加载网页",
  ).props.onClick();
  await vi.waitFor(() =>
    expect(backend.navigate).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
      url: "https://example.com/private-title",
    }),
  );
  expect(render(props).html).not.toContain("Old task content");
});

it("holds the pane from open start until a collapsed late page really hides", async () => {
  const backend = client();
  const opened =
    deferred<Awaited<ReturnType<BrowserWorkspaceClient["open"]>>>();
  const hidden = deferred<void>();
  vi.mocked(backend.open).mockReturnValueOnce(opened.promise);
  vi.mocked(backend.setVisible).mockReturnValueOnce(hidden.promise);
  const onVisibilityChange = vi.fn();
  const props = {
    taskKey: "task-a",
    active: true,
    visible: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    onVisibilityChange,
  };
  render(props);
  await Promise.resolve();
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  onVisibilityChange.mockClear();
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  render({ ...props, visible: false });
  expect(onVisibilityChange).not.toHaveBeenCalledWith(false);
  opened.resolve({
    taskKey: "task-a",
    label: "late-page",
    revision: 1,
    phase: "ready",
    url: "https://example.com/",
  });
  await vi.waitFor(() =>
    expect(backend.setVisible).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "late-page",
      visible: false,
    }),
  );
  expect(onVisibilityChange).not.toHaveBeenCalledWith(false);
  hidden.resolve();
  await vi.waitFor(() =>
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false),
  );
  expect(backend.close).not.toHaveBeenCalled();
});

it("holds a restoring page even when collapsed again before the show ACK", async () => {
  const backend = client();
  const onVisibilityChange = vi.fn();
  const props = {
    taskKey: "task-a",
    active: true,
    visible: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    onVisibilityChange,
  };
  await openedView(props);
  render({ ...props, visible: false });
  await vi.waitFor(() =>
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false),
  );
  const shown = deferred<void>();
  const hidden = deferred<void>();
  vi.mocked(backend.setVisible)
    .mockReturnValueOnce(shown.promise)
    .mockReturnValueOnce(hidden.promise);
  onVisibilityChange.mockClear();
  render({ ...props, visible: true });
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  render({ ...props, visible: false });
  shown.resolve();
  await vi.waitFor(() =>
    expect(backend.setVisible).toHaveBeenLastCalledWith({
      taskKey: "task-a",
      label: "page-a",
      visible: false,
    }),
  );
  expect(onVisibilityChange).not.toHaveBeenCalledWith(false);
  hidden.resolve();
  await vi.waitFor(() =>
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false),
  );
});

it("releases held layout after an unreserved open is rejected and retains its error", async () => {
  const backend = client();
  vi.mocked(backend.open).mockRejectedValueOnce(
    new Error("address rejected before reservation"),
  );
  const onVisibilityChange = vi.fn();
  const props = {
    taskKey: "task-a",
    active: true,
    visible: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    onVisibilityChange,
  };
  await openedView(props);
  await vi.waitFor(() =>
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false),
  );
  expect(render(props).html).toContain("未能打开网页");
  expect(backend.close).not.toHaveBeenCalled();
});

const htmlFile = {
  root: "/fixture",
  path: "game.html",
  resolvedPath: "/fixture/game.html",
  name: "game.html",
  size: 100,
  sha256: "fixture-sha",
  version: "fixture-v1",
};

function clickLabel(tree: unknown, label: string) {
  return find(
    tree,
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === label || node.props.children === label),
  ).props.onClick();
}

async function localView(props: Parameters<typeof BrowserWorkspace>[0]) {
  h.chooseFile.mockResolvedValueOnce("/fixture/game.html");
  h.inspectSelected.mockResolvedValueOnce(htmlFile);
  render(props);
  await Promise.resolve();
  clickLabel(render(props).tree, "打开 HTML…");
  await vi.waitFor(() => expect(props.client.openHtml).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(render(props).html).toContain("game.html"));
}

it("opens a picked, verified local HTML without sharing controls or a public snapshot action", async () => {
  const backend = client();
  const onStateChange = vi.fn();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    onStateChange,
    toolbar: "PUBLIC-SHARING-CONTROLS",
  };
  await localView(props);
  expect(h.inspectSelected).toHaveBeenCalledWith("/fixture/game.html");
  expect(backend.openHtml).toHaveBeenCalledWith({
    taskKey: "task-a",
    file: htmlFile,
    bounds: { x: 600, y: 200, width: 400, height: 500 },
  });
  const view = render(props);
  expect(view.html).toContain("仅支持资源内嵌的单文件 HTML");
  expect(view.html).not.toContain("PUBLIC-SHARING-CONTROLS");
  expect(view.html).not.toContain("读取文字快照");
  expect(view.html).not.toContain('type="url"');
  expect(onStateChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ localFileName: "game.html" }),
  );
  expect(backend.snapshot).not.toHaveBeenCalled();
  expect(backend.open).not.toHaveBeenCalled();
});

it.each(["cancel", "hidden", "task"])(
  "ignores a %s HTML picker result before even inspecting the selected path",
  async (outcome) => {
    const backend = client();
    const picked = deferred<string | null>();
    h.chooseFile.mockReturnValueOnce(picked.promise);
    const props = {
      taskKey: "task-a",
      active: true,
      visible: true,
      client: backend,
      guard: new BrowserSurfaceGuard(),
    };
    render(props);
    await Promise.resolve();
    clickLabel(render(props).tree, "打开 HTML…");
    if (outcome === "hidden") {
      render({ ...props, visible: false });
      render(props); // Returning does not revive the abandoned picker.
    }
    if (outcome === "task") render({ ...props, taskKey: "task-b" });
    picked.resolve(outcome === "cancel" ? null : "/fixture/game.html");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.inspectSelected).not.toHaveBeenCalled();
    expect(backend.openHtml).not.toHaveBeenCalled();
  },
);

it("does not open after file verification completes for a hidden pane", async () => {
  const backend = client();
  const checked = deferred<typeof htmlFile>();
  h.chooseFile.mockResolvedValueOnce("/fixture/game.html");
  h.inspectSelected.mockReturnValueOnce(checked.promise);
  const props = {
    taskKey: "task-a",
    active: true,
    visible: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  render(props);
  await Promise.resolve();
  clickLabel(render(props).tree, "打开 HTML…");
  await vi.waitFor(() => expect(h.inspectSelected).toHaveBeenCalledOnce());
  render({ ...props, visible: false });
  checked.resolve(htmlFile);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(backend.openHtml).not.toHaveBeenCalled();
});

it("rechecks the same local file on explicit reload and waits for old-page closure before opening its new revision", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  const checked = deferred<typeof htmlFile>();
  const closed = deferred<void>();
  h.inspect.mockReturnValueOnce(checked.promise);
  vi.mocked(backend.close).mockReturnValueOnce(closed.promise);
  clickLabel(render(props).tree, "重新载入文件");
  expect(h.inspect).toHaveBeenCalledWith("/fixture", "game.html");
  expect(backend.close).not.toHaveBeenCalled();
  const next = {
    ...htmlFile,
    sha256: "fixture-new-sha",
    version: "fixture-v2",
  };
  checked.resolve(next);
  await vi.waitFor(() =>
    expect(backend.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "local-a",
    }),
  );
  expect(backend.openHtml).toHaveBeenCalledOnce();
  closed.resolve();
  await vi.waitFor(() => expect(backend.openHtml).toHaveBeenCalledTimes(2));
  expect(vi.mocked(backend.openHtml).mock.lastCall?.[0].file).toEqual(next);
  expect(backend.navigate).not.toHaveBeenCalled();
});

it("keeps a local page visible when rechecking its changed source fails", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  h.inspect.mockRejectedValueOnce(new Error("missing"));
  clickLabel(render(props).tree, "重新载入文件");
  await vi.waitFor(() => expect(render(props).html).toContain("未能打开 HTML"));
  expect(render(props).html).toContain("game.html");
  expect(backend.close).not.toHaveBeenCalled();
  expect(backend.openHtml).toHaveBeenCalledOnce();
});

it("releases local HTML before showing the public URL entry, without navigating the local owner", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  const closed = deferred<void>();
  vi.mocked(backend.close).mockReturnValueOnce(closed.promise);
  clickLabel(render(props).tree, "打开网址");
  await vi.waitFor(() => expect(backend.close).toHaveBeenCalledOnce());
  expect(render(props).html).not.toContain('type="url"');
  closed.resolve();
  await vi.waitFor(() => expect(render(props).html).toContain('type="url"'));
  let view = render(props);
  find(view.tree, (node) => node.type === "input").props.onChange({
    target: { value: "https://example.com/" },
  });
  view = render(props);
  find(view.tree, (node) => node.type === "form").props.onSubmit({
    preventDefault() {},
  });
  await vi.waitFor(() => expect(backend.open).toHaveBeenCalledOnce());
  expect(backend.navigate).not.toHaveBeenCalled();
});

it("consumes a verified-file request once for the same visible task without reopening a picker", async () => {
  const backend = client();
  const consumed = vi.fn();
  const request = { taskKey: "task-a", file: htmlFile };
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    htmlRequest: request,
    onHtmlRequestConsumed: consumed,
  };
  render(props);
  await Promise.resolve();
  render(props);
  await vi.waitFor(() => expect(backend.openHtml).toHaveBeenCalledOnce());
  render(props);
  expect(consumed).toHaveBeenCalledOnce();
  expect(backend.openHtml).toHaveBeenCalledOnce();
  expect(h.chooseFile).not.toHaveBeenCalled();
  expect(h.inspectSelected).not.toHaveBeenCalled();
});

it("clears a closed old local page when the replacement open fails, and permits explicit reselection", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  h.inspect.mockResolvedValueOnce({ ...htmlFile, version: "v2" });
  vi.mocked(backend.openHtml).mockRejectedValueOnce(
    new Error("file changed after inspection"),
  );
  clickLabel(render(props).tree, "重新载入文件");
  await vi.waitFor(() => expect(render(props).html).toContain("未能打开 HTML"));
  expect(backend.close).toHaveBeenCalledWith({
    taskKey: "task-a",
    label: "local-a",
  });
  expect(render(props).html).not.toContain("game.html");
  expect(
    find(
      render(props).tree,
      (node) => node.type === "button" && node.props.children === "打开 HTML…",
    ).props.disabled,
  ).toBe(false);
});

it.each(["hidden", "other-task"])(
  "discards a %s verified-file request without reopening it later",
  async (kind) => {
    const backend = client();
    const consumed = vi.fn();
    const request = { taskKey: "task-a", file: htmlFile };
    const props = {
      taskKey: kind === "other-task" ? "task-b" : "task-a",
      active: true,
      visible: kind !== "hidden",
      client: backend,
      guard: new BrowserSurfaceGuard(),
      htmlRequest: request,
      onHtmlRequestConsumed: consumed,
    };
    render(props);
    await Promise.resolve();
    render({ ...props, taskKey: "task-a", visible: true });
    await Promise.resolve();
    render({ ...props, taskKey: "task-a", visible: true });
    expect(consumed).toHaveBeenCalledOnce();
    expect(backend.openHtml).not.toHaveBeenCalled();
  },
);

it("does not let a late HTML verification clear a newer picker after leaving and returning to the task", async () => {
  const backend = client();
  const oldCheck = deferred<typeof htmlFile>();
  h.chooseFile.mockResolvedValueOnce("/fixture/game.html");
  h.inspectSelected.mockReturnValueOnce(oldCheck.promise);
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  render(props);
  await Promise.resolve();
  clickLabel(render(props).tree, "打开 HTML…");
  await vi.waitFor(() => expect(h.inspectSelected).toHaveBeenCalledOnce());
  render({ ...props, taskKey: "task-b" });
  await Promise.resolve();
  render(props);
  await Promise.resolve();
  const nextPick = deferred<string | null>();
  h.chooseFile.mockReturnValueOnce(nextPick.promise);
  clickLabel(render(props).tree, "打开 HTML…");
  expect(h.chooseFile).toHaveBeenCalledTimes(2);
  oldCheck.resolve(htmlFile);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const view = render(props);
  expect(view.html).toContain("正在核实 HTML 文件");
  expect(
    find(
      view.tree,
      (node) => node.type === "button" && node.props.children === "打开 HTML…",
    ).props.disabled,
  ).toBe(true);
  expect(backend.openHtml).not.toHaveBeenCalled();
  nextPick.resolve(null);
  await vi.waitFor(() =>
    expect(
      find(
        render(props).tree,
        (node) =>
          node.type === "button" && node.props.children === "打开 HTML…",
      ).props.disabled,
    ).toBe(false),
  );
});
