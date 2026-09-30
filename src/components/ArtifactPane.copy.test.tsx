import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = next;
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
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { ArtifactPane } from "./ArtifactPane";
import { applyUpdate } from "../runtime/sessions";
import { freshThreadState } from "../runtime/session_projection";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";

type Element = ReactElement<Record<string, unknown>>;
let thread: ReturnType<typeof freshThreadState>;
let write: ReturnType<typeof vi.fn>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function render() {
  for (let pass = 0; pass < 5; pass++) {
    h.cursor = 0;
    const tree = nodes(ArtifactPane({ thread, active: false }));
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("Unexpected effect loop");
}
function copyButton() {
  return render().find(
    (node) =>
      node.type === "button" && node.props["aria-label"] === W.copyOutput,
  )!;
}
function output(id: string, kind: string, text: string) {
  applyUpdate(thread, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: id,
    kind,
    status: "completed",
    rawOutput: text,
  });
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  thread = freshThreadState("copy-output", "agent", "/work", "native");
  write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: write } });
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
});

it("copies the actual available command output and logs, with success feedback", async () => {
  const longOutput = Array.from(
    { length: 205 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  output("command", "execute", longOutput);
  output("reading", "read", "real log");
  expect(copyButton()).toBeDefined();
  await (copyButton().props.onClick as () => Promise<void>)();
  expect(write).toHaveBeenCalledWith(
    `command\n${longOutput}\n\nreading\nreal log`,
  );
  expect(
    render().some(
      (node) =>
        node.props.role === "status" && node.props.children === W.copied,
    ),
  ).toBe(true);
});

it("keeps an empty output uncopyable and exposes clipboard failure for a retry", async () => {
  output("empty", "execute", "");
  expect(copyButton()).toBeDefined();
  expect(copyButton().props.disabled).toBe(true);
  await (copyButton().props.onClick as () => Promise<void>)();
  expect(write).not.toHaveBeenCalled();
  output("filled", "execute", "some output");
  write.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await (copyButton().props.onClick as () => Promise<void>)();
  expect(
    render().some(
      (node) =>
        node.props.role === "alert" && node.props.children === W.copyFailed,
    ),
  ).toBe(true);
  expect(copyButton().props.disabled).toBe(false);
  await (copyButton().props.onClick as () => Promise<void>)();
  expect(
    render().some(
      (node) =>
        node.props.role === "status" && node.props.children === W.copied,
    ),
  ).toBe(true);
});

it("does not show a late copy success on a replacement output", async () => {
  output("first", "execute", "first output");
  let finish!: () => void;
  write.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (copyButton().props.onClick as () => Promise<void>)();
  thread = freshThreadState("copy-another", "agent", "/work", "another");
  output("second", "execute", "second output");
  render();
  finish();
  await pending;
  expect(
    render().some(
      (node) =>
        node.props.role === "status" && node.props.children === W.copied,
    ),
  ).toBe(false);
});

it("filters real output kinds and reported failures without treating error words as a failure", async () => {
  output("shell", "execute", "error is just text");
  output("failed-shell", "execute", "exit failure");
  applyUpdate(thread, {
    sessionUpdate: "tool_call_update",
    toolCallId: "failed-shell",
    status: "failed",
  });
  output("read-ok", "read", "ordinary detail");
  output("read-failed", "read", "reported failure");
  applyUpdate(thread, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-failed",
    status: "failed",
  });
  const filter = () =>
    render().find(
      (node) =>
        node.type === "select" && node.props["aria-label"] === "筛选运行输出",
    );
  expect(filter()).toBeDefined();
  (filter()!.props.onChange as (event: unknown) => void)({
    target: { value: "failed" },
  });
  const cards = render()
    .filter((node) => node.props.card)
    .map((node) => node.props.card as { title: string });
  expect(cards.map((card) => card.title)).toEqual([
    "failed-shell",
    "read-failed",
  ]);
  await (copyButton().props.onClick as () => Promise<void>)();
  expect(write).toHaveBeenLastCalledWith(
    "failed-shell\nexit failure\n\nread-failed\nreported failure",
  );
  (filter()!.props.onChange as (event: unknown) => void)({
    target: { value: "command" },
  });
  expect(
    render()
      .filter((node) => node.props.card)
      .map((node) => (node.props.card as { title: string }).title),
  ).toEqual(["shell", "failed-shell"]);
  thread = freshThreadState("another-scope", "agent", "/work", "two");
  output("new-log", "read", "new detail");
  expect(filter()!.props.value).toBe("all");
});

it("keeps filtered empty output honest and ignores late copy feedback after changing the filter", async () => {
  output("shell", "execute", "actual output");
  let finish!: () => void;
  write.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (copyButton().props.onClick as () => Promise<void>)();
  const filter = render().find(
    (node) =>
      node.type === "select" && node.props["aria-label"] === "筛选运行输出",
  );
  expect(filter).toBeDefined();
  (filter!.props.onChange as (event: unknown) => void)({
    target: { value: "failed" },
  });
  expect(copyButton().props.disabled).toBe(true);
  expect(
    render().some((node) => node.props.children === "没有符合筛选条件的输出。"),
  ).toBe(true);
  finish();
  await pending;
  expect(
    render().some(
      (node) =>
        node.props.role === "status" && node.props.children === W.copied,
    ),
  ).toBe(false);
});
