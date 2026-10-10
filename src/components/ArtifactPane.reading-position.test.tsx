import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
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
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (!slot.deps || deps.some((v, i) => !Object.is(v, slot.deps?.[i]))) {
      slot.deps = deps;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../runtime/sessions", () => ({
  threads: { closeArtifactPane: vi.fn() },
}));
import { ArtifactPane, type OpenedFileRequest } from "./ArtifactPane";
import { OpenedFileView } from "./OpenedFileView";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { freshThreadState } from "../runtime/session_projection";
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const all: Element[] = [];
  Children.forEach(tree, (n) => {
    if (isValidElement<Record<string, unknown>>(n))
      all.push(n, ...nodes(n.props.children as ReactNode));
  });
  return all;
}
let props: Parameters<typeof ArtifactPane>[0];
function render() {
  for (let i = 0; i < 6; i++) {
    h.cursor = 0;
    const tree = nodes(ArtifactPane(props));
    if (!h.effects.length) return tree;
    for (const run of h.effects.splice(0)) run();
  }
  throw new Error("unexpected effect loop");
}
function opened() {
  return render().find((n) => n.type === OpenedFileView)!;
}
function select(path: string, selection: number) {
  const fileRequest: OpenedFileRequest = {
    taskKey: props.thread.key,
    cwd: props.thread.cwd,
    path,
    selection,
  };
  props = { ...props, fileRequest };
  return opened();
}
function ref(node: Element): PreviewReadingPositionRef {
  expect(node).toBeDefined();
  expect(node.props.readingPosition).toBeDefined();
  return node.props.readingPosition as PreviewReadingPositionRef;
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  props = {
    thread: freshThreadState("first", "agent", "/work", "native"),
    active: true,
    open: true,
  };
});
afterEach(() => {
  for (const s of h.slots) s.cleanup?.();
  vi.unstubAllGlobals();
});
it("same requested path reuses its position but each explicit selection still remounts the reader", () => {
  const first = select("report.docx", 1),
    position = ref(first);
  position.current = {
    kind: "document",
    root: "/work",
    resolvedPath: "/work/report.docx",
    story: null,
    segment: 2,
  };
  position.documentWindows = {
    root: "/work",
    resolvedPath: "/work/report.docx",
    positions: new Map(),
  };
  const second = select("report.docx", 2);
  expect(ref(second)).toBe(position);
  expect(second.key).not.toBe(first.key);
  expect(ref(second).current?.kind).toBe("document");
  expect(ref(second).documentWindows).toBe(position.documentWindows);
});
it.each(["path", "thread", "cwd"])(
  "%s identity gets a new ref and old late writes cannot pollute it",
  (kind) => {
    const old = ref(select("report.docx", 1));
    old.current = {
      kind: "pdf",
      root: "/work",
      resolvedPath: "/work/report.docx",
      page: 8,
    };
    if (kind === "thread")
      props = {
        ...props,
        thread: freshThreadState("second", "agent", "/work", "native-2"),
      };
    if (kind === "cwd")
      props = { ...props, thread: { ...props.thread, cwd: "/other" } };
    const current = ref(
      select(kind === "path" ? "second.docx" : "report.docx", 2),
    );
    expect(current).not.toBe(old);
    expect(current.current).toBeNull();
    expect(current.documentWindows).toBeUndefined();
    old.current = {
      kind: "pdf",
      root: "/work",
      resolvedPath: "/work/report.docx",
      page: 99,
    };
    expect(current.current).toBeNull();
  },
);
it("only one file position is retained; visiting another file discards the first", () => {
  const a = ref(select("a.docx", 1));
  a.current = {
    kind: "text",
    root: "/work",
    resolvedPath: "/work/a.docx",
    blockIndex: 5,
  };
  const b = ref(select("b.xlsx", 2));
  const again = ref(select("a.docx", 3));
  expect(again).not.toBe(a);
  expect(again).not.toBe(b);
  expect(again.current).toBeNull();
});
it("hide/show, browser mode and back-to-list keep the current single-file ref", () => {
  const first = select("report.docx", 1),
    position = ref(first);
  props = { ...props, open: false };
  expect(ref(opened())).toBe(position);
  expect(opened().props.active).toBe(false);
  props = { ...props, open: true, contentMode: "browser" };
  expect(ref(opened())).toBe(position);
  expect(opened().props.active).toBe(false);
  expect(render().find((n) => n.type === BrowserWorkspace)).toBeDefined();
  props = { ...props, contentMode: "files" };
  (opened().props.onBack as () => void)();
  expect(opened()).toBeUndefined();
  expect(ref(select("report.docx", 2))).toBe(position);
});
it("a thread round-trip without a current file cannot revive the earlier thread position", () => {
  const first = ref(select("report.docx", 1)),
    original = props.thread;
  props = {
    ...props,
    thread: freshThreadState("second", "agent", "/work", "native-2"),
    fileRequest: null,
  };
  render();
  props = { ...props, thread: original, fileRequest: null };
  expect(ref(opened())).not.toBe(first);
  expect(ref(opened()).current).toBeNull();
});
it("distinct requested path strings do not borrow a position before the new read verifies them", () => {
  const relative = ref(select("report.docx", 1));
  const absolute = ref(select("/work/report.docx", 2));
  expect(absolute).not.toBe(relative);
  expect(absolute.current).toBeNull();
});
