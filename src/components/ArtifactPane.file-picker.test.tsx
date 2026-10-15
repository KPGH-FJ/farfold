import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
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
  threads: { closeArtifactPane: vi.fn(), openArtifactPane: vi.fn() },
}));
import { ArtifactPane } from "./ArtifactPane";
import { FilePreviewPicker } from "./FilePreviewPicker";
import { OpenedFileView } from "./OpenedFileView";
import { freshThreadState } from "../runtime/session_projection";
import type { VerifiedFile } from "../runtime/file_delivery";

type Element = ReactElement<Record<string, unknown>>;
const file: VerifiedFile = {
  root: "/chosen",
  path: "/chosen/report.pptx",
  resolvedPath: "/chosen/report.pptx",
  name: "report.pptx",
  size: 28880,
  sha256: "a".repeat(64),
  version: "v1",
};
let props: Parameters<typeof ArtifactPane>[0];
function nodes(tree: ReactNode): Element[] {
  const all: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node))
      all.push(node, ...nodes(node.props.children as ReactNode));
  });
  return all;
}
function render() {
  for (let i = 0; i < 6; i++) {
    h.cursor = 0;
    const tree = nodes(ArtifactPane(props));
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw Error("Unexpected effect loop");
}
const picker = () => render().find((node) => node.type === FilePreviewPicker)!;
const opened = () => render().find((node) => node.type === OpenedFileView);
function publish(node = picker()) {
  (node.props.onOpenFile as (file: VerifiedFile) => void)(file);
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
    thread: freshThreadState("one", "agent", "/work", "native"),
    active: true,
    open: true,
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
});

it("offers the common picker in an empty file pane without manufacturing an Agent result", () => {
  expect(props.thread.items).toHaveLength(0);
  expect(picker().props.active).toBe(true);
  expect(picker().props.workingDirectory).toBe("/work");
  expect(opened()).toBeUndefined();
  publish();
  const selected = opened()!;
  expect(selected.props.path).toBe(file.resolvedPath);
  expect(selected.props.threadKey).toBe(props.thread.key);
  expect(selected.props.active).toBe(true);
  expect(props.thread.items).toHaveLength(0);
});
it("keeps the current file until the picker explicitly publishes its checked replacement", () => {
  publish();
  const old = opened()!;
  const control = picker();
  expect(opened()?.key).toBe(old.key);
  (control.props.onOpenFile as (file: VerifiedFile) => void)({
    ...file,
    path: "/chosen/second.docx",
    resolvedPath: "/chosen/second.docx",
    name: "second.docx",
  });
  expect(opened()?.props.path).toBe("/chosen/second.docx");
  expect(opened()?.key).not.toBe(old.key);
});
it.each([
  "hide",
  "inactive",
  "thread",
  "cwd",
  "round",
  "browser",
  "hide-return",
  "browser-return",
  "thread-return",
  "round-return",
])("a retained picker result cannot replace content after %s", (change) => {
  const old = picker(),
    original = props.thread;
  if (change === "hide" || change === "hide-return")
    props = { ...props, open: false };
  if (change === "inactive") props = { ...props, active: false };
  if (change === "thread" || change === "thread-return")
    props = {
      ...props,
      thread: freshThreadState("two", "agent", "/work", "other"),
    };
  if (change === "cwd")
    props = { ...props, thread: { ...props.thread, cwd: "/other" } };
  if (change === "round" || change === "round-return")
    props.thread.artifactPaneTarget = { roundId: "round", selected: null };
  if (change === "browser" || change === "browser-return")
    props = { ...props, contentMode: "browser" };
  render();
  if (change.endsWith("-return")) {
    props = { ...props, thread: original, open: true, contentMode: "files" };
    props.thread.artifactPaneTarget = null;
    render();
  }
  expect((old.props.isCurrent as () => boolean)()).toBe(false);
  publish(old);
  expect(opened()).toBeUndefined();
});
it("retains the picker instance while browser mode withdraws its authority", () => {
  const first = picker();
  props = { ...props, contentMode: "browser" };
  const hidden = picker();
  expect(hidden.key).toBe(first.key);
  expect(hidden.props.active).toBe(false);
  expect((hidden.props.isCurrent as () => boolean)()).toBe(false);
  props = { ...props, contentMode: "files" };
  expect(picker().props.active).toBe(true);
  expect((first.props.isCurrent as () => boolean)()).toBe(false);
});

it("a new same-thread file request retires an earlier picker result", () => {
  const stale = picker();
  props = {
    ...props,
    fileRequest: {
      taskKey: props.thread.key,
      cwd: props.thread.cwd,
      path: "/chosen/newer.docx",
      selection: 41,
    },
  };
  expect(opened()?.props.path).toBe("/chosen/newer.docx");
  expect((stale.props.isCurrent as () => boolean)()).toBe(false);
  publish(stale);
  expect(opened()?.props.path).toBe("/chosen/newer.docx");
});

it("same-thread file request A-B-A does not revive the first picker", () => {
  const request = (path: string, selection: number) => {
    props = {
      ...props,
      fileRequest: {
        taskKey: props.thread.key,
        cwd: props.thread.cwd,
        path,
        selection,
      },
    };
    render();
  };
  request(file.resolvedPath, 1);
  const stale = picker();
  request("/chosen/newer.docx", 2);
  request(file.resolvedPath, 3);
  const current = opened()!;
  publish(stale);
  expect(opened()?.key).toBe(current.key);
  expect((stale.props.isCurrent as () => boolean)()).toBe(false);
});

it("an explicit file opening and return-to-list synchronously withdraw old picker callbacks", () => {
  const first = picker();
  publish(first);
  expect((first.props.isCurrent as () => boolean)()).toBe(false);
  const duringFile = picker(),
    current = opened()!;
  (current.props.onBack as () => void)();
  expect((duringFile.props.isCurrent as () => boolean)()).toBe(false);
  publish(duringFile);
  expect(opened()).toBeUndefined();
});
