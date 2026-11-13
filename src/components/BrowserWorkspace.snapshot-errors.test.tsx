import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { BrowserWorkspacePageClient as BrowserWorkspaceClient } from "../runtime/browser_workspace";
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

const protectedInput = "页面含登录输入，已停止读取；请关闭并改用公开网页";
const protectedNotice =
  "页面含密码或验证码等受保护输入，本次未读取网页文字。请改用不含这些输入的公开页面。";
const options = (backend: BrowserWorkspaceClient) => ({
  taskKey: "task-a",
  active: true,
  visible: true,
  client: backend,
  guard: new BrowserSurfaceGuard(),
  initialPage: {
    taskKey: "task-a",
    label: "page-a",
    revision: 1,
    phase: "ready" as const,
    url: "https://example.com/private-title",
  },
});
const read = (props: ReturnType<typeof options>) =>
  find(
    render(props).tree,
    (n) => n.type === "button" && n.props["aria-label"] === S.read,
  ).props.onClick();

it.each([protectedInput, new Error(protectedInput)])(
  "explains the exact protected-input refusal %s without reading or retrying automatically",
  async (failure) => {
    const backend = client(),
      props = options(backend);
    vi.mocked(backend.snapshot).mockRejectedValueOnce(failure);
    render(props);
    await Promise.resolve();
    read(props);
    await vi.waitFor(() =>
      expect(render(props).html).toContain(protectedNotice),
    );
    expect(render(props).html).not.toContain("Old task content");
    expect(render(props).html).not.toContain(S.readFailed);
    for (let i = 0; i < 5; i++) {
      render(props);
      await Promise.resolve();
    }
    expect(backend.snapshot).toHaveBeenCalledOnce();
    expect(backend.navigate).not.toHaveBeenCalled();
    expect(backend.open).not.toHaveBeenCalled();
    read(props);
    await vi.waitFor(() =>
      expect(render(props).html).toContain("Old task content"),
    );
    expect(backend.snapshot).toHaveBeenCalledTimes(2);
    expect(render(props).html).not.toContain(protectedNotice);
  },
);

const unrecognizedRejections: unknown[] = [
  "页面读取失败 SECRET_CANARY https://private.example",
  new Error(protectedInput + " SECRET_CANARY"),
  new TypeError(protectedInput),
  { message: protectedInput, diagnostic: "SECRET_CANARY" },
  { toString: () => protectedInput },
];
it.each(unrecognizedRejections)(
  "keeps unrecognized rejection generic without exposing diagnostics %#",
  async (failure) => {
    const backend = client(),
      props = options(backend);
    vi.mocked(backend.snapshot).mockRejectedValueOnce(failure);
    render(props);
    await Promise.resolve();
    read(props);
    await vi.waitFor(() => expect(render(props).html).toContain(S.readFailed));
    const html = render(props).html;
    expect(html).not.toContain("SECRET_CANARY");
    expect(html).not.toContain("private.example");
    expect(html).not.toContain(protectedNotice);
    expect(html).not.toContain("Old task content");
    expect(backend.snapshot).toHaveBeenCalledOnce();
  },
);
