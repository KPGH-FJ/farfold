import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { BrowserWorkspacePageClient as BrowserWorkspaceClient } from "../runtime/browser_workspace";
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

import { BrowserWorkspacePage as BrowserWorkspace } from "./BrowserWorkspacePage";
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
  if (
    typeof element.type === "function" &&
    element.type.name === "DangerConfirm"
  ) {
    try {
      return find(
        (element.type as (p: Record<string, any>) => unknown)(element.props),
        predicate,
      );
    } catch {
      /* Continue through children. */
    }
  }
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

// The outer tab workspace keeps each page mounted and toggles only active;
// visible stays true while selecting a different tab in the same task.
const selectedFile = {
  root: "/fixture",
  path: "game.html",
  resolvedPath: "/fixture/game.html",
  name: "game.html",
  size: 100,
  sha256: "fixture-sha",
  version: "fixture-v1",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function choose(tree: unknown) {
  return find(
    tree,
    (node) => node.type === "button" && node.props.children === S.openHtml,
  ).props.onClick();
}
function options(backend: BrowserWorkspaceClient) {
  return {
    taskKey: "task-a",
    projectDirectory: "/fixture-project",
    active: true,
    visible: true,
    client: backend,
    guard: new BrowserSurfaceGuard(),
    initialPage: {
      taskKey: "task-a",
      label: "page-a",
      revision: 1,
      phase: "ready" as const,
      url: "https://example.com/original",
    },
  };
}

it.each(["picker", "inspection"] as const)(
  "abandons the %s selection across a retained tab away-and-back without replacing its original page",
  async (phase) => {
    const backend = client(),
      picked = deferred<string | null>(),
      checked = deferred<typeof selectedFile>(),
      props = options(backend);
    h.chooseFile.mockReturnValueOnce(
      phase === "picker"
        ? picked.promise
        : Promise.resolve("/fixture/game.html"),
    );
    h.inspectSelected.mockReturnValueOnce(checked.promise);
    render(props);
    await Promise.resolve();
    choose(render(props).tree);
    if (phase === "inspection")
      await vi.waitFor(() => expect(h.inspectSelected).toHaveBeenCalledOnce());
    render({ ...props, active: false });
    render(props);
    if (phase === "picker") picked.resolve("/fixture/game.html");
    checked.resolve(selectedFile);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (phase === "picker") expect(h.inspectSelected).not.toHaveBeenCalled();
    expect(backend.openHtml).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
    expect(
      find(
        render(props).tree,
        (node) => node.type === "button" && node.props.children === S.openHtml,
      ).props.disabled,
    ).toBe(false);
  },
);
it("still replaces the reviewed original page after an uninterrupted explicit HTML selection", async () => {
  const backend = client(),
    props = options(backend);
  h.chooseFile.mockResolvedValueOnce("/fixture/game.html");
  h.inspectSelected.mockResolvedValueOnce(selectedFile);
  render(props);
  await Promise.resolve();
  choose(render(props).tree);
  await vi.waitFor(() => expect(backend.openHtml).toHaveBeenCalledOnce());
  expect(backend.close).toHaveBeenCalledExactlyOnceWith({
    taskKey: "task-a",
    label: "page-a",
  });
  expect(backend.openHtml).toHaveBeenCalledWith(
    expect.objectContaining({
      file: selectedFile,
      projectDirectory: "/fixture-project",
    }),
  );
});
