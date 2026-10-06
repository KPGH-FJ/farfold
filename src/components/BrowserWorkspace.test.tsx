import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { BrowserWorkspaceClient } from "../runtime/browser_workspace";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import { BROWSER_WORKSPACE_STRINGS as S } from "../runtime/browser_workspace_strings";

const h = vi.hoisted(() => ({
  chooseFile: vi.fn(),
  inspectSelected: vi.fn(),
  inspect: vi.fn(),
  openFile: vi.fn(),
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
  fileDelivery: {
    inspectSelected: h.inspectSelected,
    inspect: h.inspect,
    open: h.openFile,
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
    clearHtmlStorage: vi.fn(async () => {}),
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
  h.openFile.mockReset();
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
    projectDirectory: "/fixture-project",
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

it("hides an inactive task without closing its page, then restores the same owner", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = {
    projectDirectory: "/fixture-project",
    taskKey: "task-a",
    active: true,
    client: backend,
    guard,
  };
  await openedView(props);
  expect(render({ ...props, active: false }).html).toBe("");
  await vi.waitFor(() =>
    expect(backend.setVisible).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "page-a",
      visible: false,
    }),
  );
  expect(backend.close).not.toHaveBeenCalled();
  expect(backend.listenState).toHaveBeenCalledOnce();
  render(props);
  await vi.waitFor(() =>
    expect(backend.setVisible).toHaveBeenLastCalledWith({
      taskKey: "task-a",
      label: "page-a",
      visible: true,
      bounds: { x: 600, y: 200, width: 400, height: 500 },
    }),
  );
  expect(backend.open).toHaveBeenCalledOnce();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("registers an in-flight open before navigation and waits for its exact hide ACK", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const opened =
    deferred<Awaited<ReturnType<BrowserWorkspaceClient["open"]>>>();
  const hidden = deferred<void>();
  vi.mocked(backend.open).mockReturnValue(opened.promise);
  vi.mocked(backend.setVisible).mockReturnValue(hidden.promise);
  const props = {
    projectDirectory: "/fixture-project",
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
    expect(backend.setVisible).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "late-page",
      visible: false,
    }),
  );
  expect(navigate).not.toHaveBeenCalled();
  hidden.resolve();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(backend.close).not.toHaveBeenCalled();
});

it("keeps a covering panel pending on hide failure, then explicitly retries closure before showing it", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = {
    projectDirectory: "/fixture-project",
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
  vi.mocked(backend.setVisible).mockRejectedValueOnce(
    new Error("fixture hide failure"),
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
  const props = {
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
      projectDirectory: "/fixture-project",
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

it.each(
  [
    [D.checkWaitExpired, D.checkWaitExpired],
    [D.checkBusy, D.checkBusy],
    ["UNKNOWN_ERROR_WITH_PRIVATE_PATH", S.htmlFailed],
  ].flatMap(([failure, message]) =>
    ["inspection", "opening"].map((stage) => ({ stage, failure, message })),
  ),
)(
  "recovers HTML after $stage rejects with $failure",
  async ({ stage, failure, message }) => {
    const backend = client();
    h.chooseFile.mockResolvedValueOnce("/fixture/game.html");
    if (stage === "inspection")
      h.inspectSelected.mockRejectedValueOnce(failure);
    else {
      h.inspectSelected.mockResolvedValueOnce(htmlFile);
      vi.mocked(backend.openHtml).mockRejectedValueOnce(failure);
    }
    const props = {
      projectDirectory: "/fixture-project",
      taskKey: "task-a",
      active: true,
      client: backend,
      guard: new BrowserSurfaceGuard(),
    };
    render(props);
    await Promise.resolve();
    clickLabel(render(props).tree, S.openHtml);
    await vi.waitFor(() => expect(h.inspectSelected).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(render(props).html).toContain(message));
    const view = render(props);
    expect(view.html).not.toContain(S.choosingHtml);
    expect(view.html).not.toContain("UNKNOWN_ERROR_WITH_PRIVATE_PATH");
    expect(
      find(
        view.tree,
        (node) => node.type === "button" && node.props.children === S.openHtml,
      ).props.disabled,
    ).toBe(false);
    expect(backend.openHtml).toHaveBeenCalledTimes(stage === "opening" ? 1 : 0);
    expect(backend.open).not.toHaveBeenCalled();
  },
);

it("does not open after file verification completes for a hidden pane", async () => {
  const backend = client();
  const checked = deferred<typeof htmlFile>();
  h.chooseFile.mockResolvedValueOnce("/fixture/game.html");
  h.inspectSelected.mockReturnValueOnce(checked.promise);
  const props = {
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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
      projectDirectory: "/fixture-project",
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
    projectDirectory: "/fixture-project",
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

it("opens only the exact displayed local file receipt in the browser without reopening or navigating the embedded page", async () => {
  const backend = client();
  const props = {
    projectDirectory: "/fixture-project",
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  const pending = deferred<void>();
  h.openFile.mockReturnValueOnce(pending.promise);
  const click = () =>
    find(
      render(props).tree,
      (node) => node.type === "button" && node.props.title === "在浏览器打开",
    ).props.onClick();
  click();
  click();
  expect(h.openFile).toHaveBeenCalledExactlyOnceWith(htmlFile);
  expect(
    find(
      render(props).tree,
      (node) => node.type === "button" && node.props.title === "在浏览器打开",
    ).props.disabled,
  ).toBe(true);
  pending.resolve();
  await vi.waitFor(() =>
    expect(
      find(
        render(props).tree,
        (node) => node.type === "button" && node.props.title === "在浏览器打开",
      ).props.disabled,
    ).toBe(false),
  );
  expect(backend.openHtml).toHaveBeenCalledOnce();
  expect(backend.navigate).not.toHaveBeenCalled();
  expect(backend.close).not.toHaveBeenCalled();
  expect(h.inspect).not.toHaveBeenCalled();
});

it("keeps the embedded document and reports a failed browser open without substituting a new file", async () => {
  const backend = client();
  const props = {
    projectDirectory: "/fixture-project",
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  h.openFile.mockRejectedValueOnce(new Error("file changed"));
  find(
    render(props).tree,
    (node) => node.type === "button" && node.props.title === "在浏览器打开",
  ).props.onClick();
  await vi.waitFor(() =>
    expect(render(props).html).toContain("未能在浏览器打开"),
  );
  expect(render(props).html).toContain("game.html");
  expect(h.openFile).toHaveBeenCalledExactlyOnceWith(htmlFile);
  expect(h.inspect).not.toHaveBeenCalled();
  expect(backend.close).not.toHaveBeenCalled();
});

it("a hidden local page cannot launch the external browser", async () => {
  const backend = client();
  const props = {
    projectDirectory: "/fixture-project",
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  const hidden = render({ ...props, visible: false });
  const button = find(
    hidden.tree,
    (node) => node.type === "button" && node.props.title === "在浏览器打开",
  );
  expect(button.props.disabled).toBe(true);
  button.props.onClick();
  expect(h.openFile).not.toHaveBeenCalled();
});

it("restores the same page after a sidebar layout transition without navigation or reopening", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = {
    projectDirectory: "/fixture-project",
    taskKey: "task-a",
    active: true,
    client: backend,
    guard,
  };
  await openedView(props);
  const layout = vi.fn();
  guard.runLatest(layout);
  await vi.waitFor(() => expect(layout).toHaveBeenCalledOnce());
  render(props);
  await vi.waitFor(() =>
    expect(backend.setVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        taskKey: "task-a",
        label: "page-a",
        visible: true,
      }),
    ),
  );
  expect(backend.open).toHaveBeenCalledOnce();
  expect(backend.close).not.toHaveBeenCalled();
});

it("observes a real close while inactive and never restores that departed page", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  let publish!: Parameters<BrowserWorkspaceClient["listenState"]>[0];
  vi.mocked(backend.listenState).mockImplementation(async (listener) => {
    publish = listener;
    return () => {};
  });
  const props = {
    projectDirectory: "/fixture-project",
    taskKey: "task-a",
    active: true,
    client: backend,
    guard,
  };
  await openedView(props);
  render({ ...props, active: false });
  publish({
    taskKey: "task-a",
    label: "page-a",
    phase: "closed",
    revision: 2,
    url: "https://example.com/",
  });
  render({ ...props, active: false });
  expect(guard.hasSurfaces).toBe(false);
  vi.mocked(backend.setVisible).mockClear();
  render(props);
  await Promise.resolve();
  expect(backend.setVisible).not.toHaveBeenCalledWith(
    expect.objectContaining({ visible: true }),
  );
});

function storageClient(persistent: boolean | undefined = true) {
  const backend = client();
  vi.mocked(backend.openHtml).mockResolvedValue({
    taskKey: "task-a",
    label: "local-a",
    revision: 1,
    phase: "ready",
    url: "about:blank",
    localFileName: "game.html",
    ...(persistent === undefined ? {} : { localStoragePersistent: persistent }),
  });
  return backend;
}

it.each([true, false, "unknown"] as const)(
  "uses the actual %s storage receipt for local hints",
  async (kind) => {
    const backend = storageClient(kind === "unknown" ? undefined : kind);
    // Passing undefined uses the helper default; remove it explicitly here.
    if (kind === "unknown")
      vi.mocked(backend.openHtml).mockResolvedValue({
        taskKey: "task-a",
        label: "local-a",
        revision: 1,
        phase: "ready",
        url: "about:blank",
        localFileName: "game.html",
      });
    const props = {
      taskKey: "task-a",
      projectDirectory: "/fixture-project",
      active: true,
      client: backend,
      guard: new BrowserSurfaceGuard(),
    };
    await localView(props);
    const html = render(props).html;
    expect(html).toContain(
      kind === true
        ? "本文件的页面存档会保留"
        : kind === false
          ? "当前系统使用临时页面存档"
          : "尚未确认是否能保留页面存档",
    );
    expect(html.includes("清除本文件存档")).toBe(kind === true);
  },
);

it("asks about this file before clearing, supports keeping it, and reports success only after the real receipt", async () => {
  const backend = storageClient();
  const props = {
    taskKey: "task-a",
    projectDirectory: "/fixture-project",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  clickLabel(render(props).tree, "清除本文件存档…");
  expect(render(props).html).toContain(
    "原 HTML 文件、其他文件及外部浏览器存档不受影响",
  );
  expect(backend.clearHtmlStorage).not.toHaveBeenCalled();
  clickLabel(render(props).tree, "保留存档");
  expect(render(props).html).not.toContain("关闭并清除存档");
  clickLabel(render(props).tree, "清除本文件存档…");
  const pending = deferred<void>();
  vi.mocked(backend.clearHtmlStorage).mockReturnValueOnce(pending.promise);
  const confirm = find(
    render(props).tree,
    (node) =>
      node.type === "button" && node.props.children === "关闭并清除存档",
  ).props.onClick;
  confirm();
  confirm();
  await vi.waitFor(() =>
    expect(backend.clearHtmlStorage).toHaveBeenCalledExactlyOnceWith({
      taskKey: "task-a",
      label: "local-a",
    }),
  );
  expect(render(props).html).toContain("正在关闭页面并清除存档");
  expect(render(props).html).not.toContain("本文件存档已清除");
  pending.resolve();
  await vi.waitFor(() =>
    expect(render(props).html).toContain("本文件存档已清除"),
  );
  expect(backend.openHtml).toHaveBeenCalledOnce();
  expect(props.guard.hasSurfaces).toBe(false);
});

it("does not report deletion success when closing succeeds but clearing fails", async () => {
  const backend = storageClient();
  const props = {
    taskKey: "task-a",
    projectDirectory: "/fixture-project",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  vi.mocked(backend.clearHtmlStorage).mockRejectedValueOnce(
    new Error("deletion failed"),
  );
  clickLabel(render(props).tree, "清除本文件存档…");
  clickLabel(render(props).tree, "关闭并清除存档");
  await vi.waitFor(() =>
    expect(render(props).html).toContain("未能确认存档已清除"),
  );
  expect(render(props).html).not.toContain("本文件存档已清除");
  expect(backend.close).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task-a",
    label: "local-a",
  });
});

it.each(["hide", "inactive", "project", "task"])(
  "invalidates a clear confirmation after %s and ignores its stale action",
  async (kind) => {
    const backend = storageClient();
    const props = {
      taskKey: "task-a",
      projectDirectory: "/fixture-project",
      active: true,
      client: backend,
      guard: new BrowserSurfaceGuard(),
    };
    await localView(props);
    clickLabel(render(props).tree, "清除本文件存档…");
    const confirm = find(
      render(props).tree,
      (node) =>
        node.type === "button" && node.props.children === "关闭并清除存档",
    ).props.onClick;
    render({
      ...props,
      ...(kind === "hide"
        ? { visible: false }
        : kind === "inactive"
          ? { active: false }
          : kind === "project"
            ? { projectDirectory: "/other-project" }
            : { taskKey: "task-b" }),
    });
    confirm();
    await Promise.resolve();
    expect(backend.clearHtmlStorage).not.toHaveBeenCalled();
  },
);

it("a late clear receipt cannot show success or clear state for another task", async () => {
  const backend = storageClient();
  const props = {
    taskKey: "task-a",
    projectDirectory: "/fixture-project",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await localView(props);
  const pending = deferred<void>();
  vi.mocked(backend.clearHtmlStorage).mockReturnValueOnce(pending.promise);
  clickLabel(render(props).tree, "清除本文件存档…");
  clickLabel(render(props).tree, "关闭并清除存档");
  await vi.waitFor(() =>
    expect(backend.clearHtmlStorage).toHaveBeenCalledOnce(),
  );
  const next = {
    ...props,
    taskKey: "task-b",
    projectDirectory: "/other-project",
  };
  render(next);
  pending.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(render(next).html).not.toContain("本文件存档已清除");
  expect(render(next).html).not.toContain("game.html");
  expect(backend.clearHtmlStorage).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task-a",
    label: "local-a",
  });
});

it("requires the task project for HTML instead of using the file access root", async () => {
  const backend = storageClient();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    htmlRequest: { taskKey: "task-a", file: htmlFile },
  };
  render(props);
  await Promise.resolve();
  render(props);
  await vi.waitFor(() =>
    expect(render(props).html).toContain("请先为当前对话选择工作文件夹"),
  );
  expect(backend.openHtml).not.toHaveBeenCalled();
});

it("never offers clear for public pages", async () => {
  const backend = client();
  const props = {
    taskKey: "task-a",
    active: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
  };
  await openedView(props);
  expect(render(props).html).not.toContain("清除本文件存档");
});

it("closes the current HTML owner on unmount after replacing an earlier page", async () => {
  const backend = client();
  const guard = new BrowserSurfaceGuard();
  const props = {
    taskKey: "task-a",
    projectDirectory: "/fixture-project",
    active: true,
    client: backend,
    guard,
  };
  await openedView(props);
  await localView(props);
  expect(backend.close).toHaveBeenCalledWith({
    taskKey: "task-a",
    label: "page-a",
  });
  for (const effect of h.effects) effect.cleanup?.();
  await vi.waitFor(() =>
    expect(backend.close).toHaveBeenCalledWith({
      taskKey: "task-a",
      label: "local-a",
    }),
  );
  await vi.waitFor(() => expect(guard.hasSurfaces).toBe(false));
});

it.each(["directory", "development"] as const)(
  "reloads %s in its existing owner without a picker or replacement store",
  async (mode) => {
    const backend = client();
    const state = {
      taskKey: "task-a",
      label: "preview-owner",
      revision: 1,
      phase: "ready" as const,
      url:
        mode === "directory"
          ? "ff-preview://preview-test/index.html"
          : "http://127.0.0.1:3000/",
      previewMode: mode,
      ...(mode === "directory"
        ? { localFileName: "index.html", localStoragePersistent: true }
        : {}),
    };
    backend.openDirectory = vi.fn(async () => state);
    backend.openDevelopment = vi.fn(async () => state);
    vi.mocked(backend.navigate).mockResolvedValue({ ...state, revision: 2 });
    const props = {
      taskKey: "task-a",
      projectDirectory: "/fixture-project",
      active: true,
      client: backend,
      guard: new BrowserSurfaceGuard(),
    };
    render(props);
    await Promise.resolve();
    if (mode === "directory") {
      h.chooseFile.mockResolvedValueOnce("/fixture-project/index.html");
      clickLabel(render(props).tree, "打开项目网页…");
      await vi.waitFor(() =>
        expect(backend.openDirectory).toHaveBeenCalledOnce(),
      );
    } else {
      find(render(props).tree, (n) => n.type === "select").props.onChange({
        target: { value: "development" },
      });
      find(render(props).tree, (n) => n.type === "input").props.onChange({
        target: { value: state.url },
      });
      await find(render(props).tree, (n) => n.type === "form").props.onSubmit({
        preventDefault() {},
      });
      await vi.waitFor(() =>
        expect(backend.openDevelopment).toHaveBeenCalledOnce(),
      );
    }
    await vi.waitFor(() =>
      expect(render(props).html).toContain(
        mode === "directory" ? "index.html" : "本机服务地址",
      ),
    );
    clickLabel(
      render(props).tree,
      mode === "directory" ? "重新载入文件" : "重新加载网页",
    );
    await vi.waitFor(() =>
      expect(backend.navigate).toHaveBeenCalledExactlyOnceWith({
        taskKey: "task-a",
        label: state.label,
        url: state.url,
      }),
    );
    expect(backend.close).not.toHaveBeenCalled();
    expect(
      mode === "directory" ? backend.openDirectory : backend.openDevelopment,
    ).toHaveBeenCalledOnce();
    expect(h.chooseFile).toHaveBeenCalledTimes(mode === "directory" ? 1 : 0);
    if (mode === "directory")
      expect(render(props).html).not.toContain("在浏览器打开");
  },
);
