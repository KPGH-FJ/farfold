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
    connect: noop,
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

import { browserSurfaceGuard } from "../runtime/browser_surface";
import { ThreadView } from "./ThreadView";
import { ArtifactPane } from "./ArtifactPane";
import { threads } from "../runtime/sessions";
import { MessageCopyButton, RawBlock, ToolStep } from "./thread-items";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";
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

function addReported() {
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: "source",
    kind: "edit",
    status: "completed",
    title: "completed",
    locations: [{ path: "report.pdf" }],
    content: [],
  });
}
it.each(["inactive", "return", "cwd", "thread"])(
  "captured tool entry cannot navigate after %s",
  (change) => {
    addReported();
    const old = render().tree.find((n) => n.type === ToolStep)!;
    const navigate = vi.spyOn(threads, "openArtifactPane");
    if (change === "inactive" || change === "return") render(false);
    if (change === "return") render(true);
    if (change === "cwd") {
      thread.cwd = "/other";
      render();
    }
    if (change === "thread") {
      thread = freshThreadState("other", "a", "/p", "other-native");
      render();
    }
    if (change === "removed") thread.items = [];
    (old.props.onOpenArtifacts as (e: unknown) => void)({ currentTarget: {} });
    expect(navigate).not.toHaveBeenCalled();
  },
);
it("a current explicit tool entry navigates to its exact item and does not read", () => {
  addReported();
  const tool = thread.items[0];
  const view = render().tree.find((n) => n.type === ToolStep)!;
  const navigate = vi.spyOn(threads, "openArtifactPane");
  (view.props.onOpenArtifacts as (e: unknown) => void)({ currentTarget: {} });
  expect(navigate).toHaveBeenCalledExactlyOnceWith(thread.key, tool.id);
});

it("native surface wait does not dispatch a captured tool entry after its working directory changed", async () => {
  addReported();
  const old = render().tree.find((n) => n.type === ToolStep)!;
  let resolve!: () => void;
  const registration = browserSurfaceGuard.register(
    () => new Promise<void>((done) => (resolve = done)),
  );
  const navigate = vi.spyOn(threads, "openArtifactPane");
  (old.props.onOpenArtifacts as (event: unknown) => void)({
    currentTarget: {},
  });
  expect(navigate).not.toHaveBeenCalled();
  thread.cwd = "/other";
  render();
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  registration.release();
  expect(navigate).not.toHaveBeenCalled();
});
