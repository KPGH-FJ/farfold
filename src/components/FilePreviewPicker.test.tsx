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
  open: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === "function" ? value(slot.value) : value;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    ) {
      slot.deps = deps;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: { inspectSelected: h.inspect },
}));
import { FilePreviewPicker } from "./FilePreviewPicker";
import { useContentOwner } from "./useContentOwner";
import { freshThreadState } from "../runtime/session_projection";
import { FILE_PREVIEW_PICKER_STRINGS as S } from "../runtime/file_preview_picker_strings";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import type { VerifiedFile } from "../runtime/file_delivery";

type Element = ReactElement<Record<string, unknown>>;
const onOpen = vi.fn();
const file: VerifiedFile = {
  root: "/outside",
  path: "/outside/report.pptx",
  resolvedPath: "/outside/report.pptx",
  name: "report.pptx",
  size: 28880,
  version: "checked-one",
  sha256: "a".repeat(64),
};
let thread = freshThreadState("one", "agent", "/work", "native"),
  active = true,
  scope: string | null = null;
let settle: (() => void)[] = [];
const drain = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  settle.push(() => resolve(null as T));
  return { resolve, reject, promise };
}
function nodes(tree: ReactNode): Element[] {
  const all: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node))
      all.push(node, ...nodes(node.props.children as ReactNode));
  });
  return all;
}
function render() {
  h.cursor = 0;
  const owner = useContentOwner(thread, active, scope);
  const tree = nodes(
    FilePreviewPicker({
      active,
      workingDirectory: thread.cwd,
      isCurrent: owner,
      onOpenFile: onOpen,
    }),
  );
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
function button() {
  return render().find((node) => node.type === "button")!;
}
function click(node = button()) {
  (node.props.onClick as () => void)();
}
function unmount() {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots = [];
  h.effects = [];
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.open.mockReset();
  h.inspect.mockReset();
  onOpen.mockReset();
  settle = [];
  thread = freshThreadState("one", "agent", "/work", "native");
  active = true;
  scope = null;
  h.open.mockResolvedValue(null);
  h.inspect.mockResolvedValue(file);
});
afterEach(async () => {
  for (const complete of settle) complete();
  await drain();
  unmount();
});

it("opens an explicit single-file dialog and cancellation never inspects or replaces existing content", async () => {
  click();
  await drain();
  expect(h.open).toHaveBeenCalledExactlyOnceWith({
    title: S.title,
    multiple: false,
    directory: false,
    defaultPath: "/work",
  });
  expect(h.inspect).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(button().props.disabled).toBe(false);
});
it("keeps existing content through selection and inspection, then publishes only the exact seven-field receipt", async () => {
  const dialog = deferred<string | null>(),
    inspection = deferred<VerifiedFile>();
  h.open.mockReturnValue(dialog.promise);
  h.inspect.mockReturnValue(inspection.promise);
  const old = button();
  click(old);
  click(old);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(button().props.disabled).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  dialog.resolve(file.path);
  await drain();
  expect(h.inspect).toHaveBeenCalledExactlyOnceWith(file.path);
  expect(onOpen).not.toHaveBeenCalled();
  expect(button().props.disabled).toBe(true);
  inspection.resolve(file);
  await drain();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(file);
  expect(button().props.disabled).toBe(false);
});
it.each(["hide-return", "thread-return", "cwd-return", "round-return"])(
  "retires a dialog across %s without releasing its actual admission early",
  async (change) => {
    const dialog = deferred<string | null>();
    h.open.mockReturnValue(dialog.promise);
    const oldThread = thread;
    click();
    if (change === "hide-return") active = false;
    if (change === "thread-return")
      thread = freshThreadState("two", "agent", "/work", "other");
    if (change === "cwd-return") thread = { ...thread, cwd: "/other" };
    if (change === "round-return") {
      thread.artifactPaneTarget = { roundId: "next-round", selected: null };
      scope = "next-round";
    }
    render();
    thread = oldThread;
    active = true;
    scope = null;
    thread.artifactPaneTarget = null;
    render();
    expect(button().props.disabled).toBe(true);
    click();
    expect(h.open).toHaveBeenCalledTimes(1);
    dialog.resolve(file.path);
    await drain();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
  },
);
it.each(["hide-return", "thread-return", "cwd-return", "round-return"])(
  "discards inspection after %s and keeps admission until its receipt settles",
  async (change) => {
    const inspection = deferred<VerifiedFile>();
    h.open.mockResolvedValue(file.path);
    h.inspect.mockReturnValue(inspection.promise);
    click();
    await drain();
    const oldThread = thread;
    if (change === "hide-return") active = false;
    if (change === "thread-return")
      thread = freshThreadState("two", "agent", "/work", "other");
    if (change === "cwd-return") thread = { ...thread, cwd: "/other" };
    if (change === "round-return") {
      thread.artifactPaneTarget = { roundId: "next-round", selected: null };
      scope = "next-round";
    }
    render();
    thread = oldThread;
    active = true;
    scope = null;
    thread.artifactPaneTarget = null;
    render();
    click();
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    inspection.resolve(file);
    await drain();
    expect(onOpen).not.toHaveBeenCalled();
    expect(button().props.disabled).toBe(false);
  },
);
it("retains the real dialog across unmount/remount and never revives an earlier owner", async () => {
  const dialog = deferred<string | null>();
  h.open.mockReturnValue(dialog.promise);
  click();
  unmount();
  thread = freshThreadState("two", "agent", "/work", "second");
  expect(button().props.disabled).toBe(true);
  click();
  expect(h.open).toHaveBeenCalledTimes(1);
  dialog.resolve(file.path);
  await drain();
  expect(onOpen).not.toHaveBeenCalled();
  expect(h.inspect).not.toHaveBeenCalled();
  expect(button().props.disabled).toBe(false);
});
it.each([
  null,
  { ...file, path: "/outside/another.pptx" },
  { ...file, root: "relative" },
  { ...file, sha256: "bad" },
  { ...file, size: -1 },
  { ...file, version: "" },
  { ...file, name: "" },
])(
  "refuses an invalid or mismatched receipt without replacing content",
  async (value) => {
    h.open.mockResolvedValue(file.path);
    h.inspect.mockResolvedValue(value);
    click();
    await drain();
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      render().some(
        (node) =>
          node.props.role === "alert" && node.props.children === S.failed,
      ),
    ).toBe(true);
  },
);
it.each(["not a single path", [file.path]])(
  "refuses an unexpected dialog shape without inspecting",
  async (value) => {
    h.open.mockResolvedValue(value);
    click();
    await drain();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(render().some((node) => node.props.role === "alert")).toBe(true);
  },
);
it.each([
  new Error("ACP runtime secret detail"),
  { code: "unexpected", path: "/private/secret" },
])("shows a fixed safe message for unknown failures", async (cause) => {
  h.open.mockRejectedValue(cause);
  click();
  await drain();
  expect(
    render().find((node) => node.props.role === "alert")?.props.children,
  ).toBe(S.failed);
  expect(onOpen).not.toHaveBeenCalled();
});
it.each([D.checkWaitExpired, D.checkBusy])(
  "preserves fixed uncertain inspection notices",
  async (cause) => {
    h.open.mockResolvedValue(file.path);
    h.inspect.mockRejectedValue(cause);
    click();
    await drain();
    expect(
      render().find((node) => node.props.role === "alert")?.props.children,
    ).toBe(cause);
    expect(onOpen).not.toHaveBeenCalled();
  },
);
it("retires a visible error after navigation rather than reviving it on return", async () => {
  h.open.mockRejectedValue(new Error("unknown"));
  click();
  await drain();
  expect(render().some((node) => node.props.role === "alert")).toBe(true);
  active = false;
  render();
  active = true;
  expect(render().some((node) => node.props.role === "alert")).toBe(false);
});
it("allows choosing a local file before a work folder exists", async () => {
  thread = { ...thread, cwd: "" };
  click();
  await drain();
  expect(h.open).toHaveBeenCalledExactlyOnceWith({
    title: S.title,
    multiple: false,
    directory: false,
  });
});
it("uses concise user-facing strings without internal terms", () => {
  const forbidden =
    /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i;
  expect(
    Object.values(S).filter((text) => !text.trim() || forbidden.test(text)),
  ).toEqual([]);
});
