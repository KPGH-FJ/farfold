import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadState } from "../runtime/session_types";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  snapshot: {
    threads: new Map<string, ThreadState>(),
    index: [] as {
      id: string;
      agentId: string;
      cwd: string;
      nativeSessionId: string | null;
    }[],
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
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
  useRef(initial: unknown) {
    return (h.slots[h.cursor++] ??= { value: { current: initial } }).value;
  },
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
    const index = h.cursor++,
      previous = h.slots[index];
    if (
      !previous ||
      !deps ||
      previous.deps?.length !== deps.length ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      const slot = { deps, cleanup: previous?.cleanup };
      h.slots[index] = slot;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => h.snapshot,
  threads: { getSnapshot: () => h.snapshot },
}));
import { SelectedAttachmentSearch } from "./SelectedAttachmentSearch";
import { AttachmentSearch } from "../runtime/attachment_search";
import {
  attachmentSearchSourceCurrent,
  type AttachmentSearchCandidate,
} from "../runtime/attachment_search_source";
import { freshThreadState } from "../runtime/session_projection";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";

type Element = { type: unknown; props: Record<string, unknown> };
const aName = "chosen-a.txt";
const aPath = "/memory-selection/a/chosen-a.txt";
const aTitle = "THREAD-A-OWNER";
const calls = {
  inspect: vi.fn(),
  read: vi.fn(),
  check: vi.fn(),
};
let controller: AttachmentSearch;
let props: Parameters<typeof SelectedAttachmentSearch>[0];

function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  if (value.props.hidden || value.props["aria-hidden"] === true) return [];
  return [value, ...nodes(value.props.children as ReactNode)];
}
function text(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  if (!isValidElement<Record<string, unknown>>(value)) return "";
  if (value.props.hidden || value.props["aria-hidden"] === true) return "";
  return text(value.props.children as ReactNode);
}
// Same controlled hook-commit model as recovery.test.tsx. The component,
// handlers, controller snapshot and WeakMap source ownership are real. This
// witnesses a rendered control contract, not browser layout or native I/O.
function render() {
  for (let pass = 0; pass < 10; pass++) {
    h.cursor = 0;
    const root = SelectedAttachmentSearch(props);
    const effects = h.effects.splice(0);
    if (!effects.length) return { root, elements: nodes(root) };
    effects.forEach((effect) => effect());
  }
  throw new Error("Unexpected controlled effect loop");
}
function button(label: string, view = render()) {
  const result = view.elements.find(
    (node) =>
      node.type === "button" &&
      text(node.props.children as ReactNode) === label,
  );
  expect(result, `Missing ${label}`).toBeDefined();
  return result!;
}
function clickStart() {
  const target = button(S.start);
  expect(target.props.disabled).toBe(false);
  (target.props.onClick as () => void)();
}
function checkbox(name: string, view = render()) {
  const label = view.elements.find(
    (node) =>
      node.type === "label" &&
      text(node.props.children as ReactNode).includes(name),
  );
  return label
    ? nodes(label.props.children as ReactNode).find(
        (node) => node.type === "input" && node.props.type === "checkbox",
      )
    : undefined;
}
function choose(name: string) {
  const target = checkbox(name);
  expect(target, `Missing selectable ${name}`).toBeDefined();
  expect(Boolean(target!.props.disabled)).toBe(false);
  (target!.props.onChange as (event: { target: { checked: boolean } }) => void)(
    {
      target: { checked: true },
    },
  );
}
function removalForA(view: ReturnType<typeof render>) {
  // Accept a checked checkbox or a readable remove/cancel button associated
  // with the source. This does not prescribe a new private component or label.
  const entries = view.elements
    .filter((node) => {
      const body = text(node.props.children as ReactNode);
      return [aName, aTitle, aPath].every((part) => body.includes(part));
    })
    .sort(
      (a, b) =>
        text(a.props.children as ReactNode).length -
        text(b.props.children as ReactNode).length,
    );
  for (const entry of entries) {
    const control = nodes(entry.props.children as ReactNode).find(
      (node) =>
        !node.props.disabled &&
        ((node.type === "input" &&
          node.props.type === "checkbox" &&
          node.props.checked === true &&
          typeof node.props.onChange === "function") ||
          (node.type === "button" &&
            typeof node.props.onClick === "function" &&
            /取消|移除|清除/.test(
              `${node.props["aria-label"] ?? ""} ${text(node.props.children as ReactNode)}`,
            ))),
    );
    if (control) return control;
  }
  return undefined;
}
function remove(control: Element) {
  if (control.type === "input")
    (
      control.props.onChange as (event: {
        target: { checked: boolean };
      }) => void
    )({
      target: { checked: false },
    });
  else
    (control.props.onClick as (event: { currentTarget: unknown }) => void)({
      currentTarget: {},
    });
}
function fixture(key: "a" | "b", count: number) {
  const thread = freshThreadState(
    key,
    "controlled",
    "/memory-selection",
    `native-${key}`,
  );
  thread.items = [
    {
      kind: "user",
      id: `message-${key}`,
      time: 1,
      streaming: false,
      text: "Memory attachment declarations only",
      attachments: Array.from({ length: count }, (_, i) => ({
        name: key === "a" ? aName : `b-${i}.txt`,
        uri:
          key === "a"
            ? `file://${aPath}`
            : `file:///memory-selection/b/b-${i}.txt`,
      })),
    },
  ];
  return thread;
}
function setup(bCount: number) {
  const a = fixture("a", 1),
    b = fixture("b", bCount);
  h.snapshot = {
    threads: new Map([
      ["a", a],
      ["b", b],
    ]),
    index: [a, b].map((thread) => ({
      id: thread.key,
      agentId: thread.agentId,
      cwd: thread.cwd,
      nativeSessionId: thread.nativeSessionId,
    })),
  };
  props = {
    active: true,
    rows: [
      { key: "a", title: aTitle },
      { key: "b", title: "THREAD-B-OWNER" },
    ] as Parameters<typeof SelectedAttachmentSearch>[0]["rows"],
    query: "needle",
    scopeKey: "same-members",
    controller,
  };
  return { a, b };
}
function isCurrent(source: AttachmentSearchCandidate) {
  return attachmentSearchSourceCurrent(
    source,
    h.snapshot.threads,
    props.rows.map((row) => row.key),
    h.snapshot.index,
  );
}
function noReads() {
  expect(calls.inspect).not.toHaveBeenCalled();
  expect(calls.read).not.toHaveBeenCalled();
  expect(calls.check).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  vi.clearAllMocks();
  controller = new AttachmentSearch(calls);
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.restoreAllMocks();
});

it("retains the two-item reorder positive control without silently changing the selected read scope", () => {
  setup(1);
  const start = vi.spyOn(controller, "start").mockResolvedValue(false);
  expect(button(S.start).props.disabled).toBe(true);
  expect(start).not.toHaveBeenCalled();
  choose(aName);
  choose("b-0.txt");
  clickStart();
  const original = start.mock.calls[0][1];
  props = { ...props, rows: [...props.rows].reverse() };
  expect(checkbox(aName)?.props.checked).toBe(true);
  expect(checkbox("b-0.txt")?.props.checked).toBe(true);
  clickStart();
  expect(start.mock.calls[1][1]).toBe(original);
  expect(start.mock.calls[1][1].map((source) => source.threadKey)).toEqual([
    "a",
    "b",
  ]);
  expect(original.every(isCurrent)).toBe(true);
  expect(start.mock.calls[1][2]()).toBe(true);
  noReads();
});

it("keeps selected valid A readable and removable when B's 1000 declarations move before it", () => {
  const { a, b } = setup(1000);
  const sourceState = JSON.stringify([...h.snapshot.threads]);
  const aItem = a.items[0];
  if (aItem.kind !== "user") throw new Error("Missing controlled A message");
  const attachment = aItem.attachments[0],
    index = h.snapshot.index,
    originalKeys = props.rows.map((row) => row.key).sort();
  const bItem = b.items[0];
  if (bItem.kind !== "user") throw new Error("Missing controlled B message");
  expect(aItem.attachments.length + bItem.attachments.length).toBe(1001);
  const start = vi.spyOn(controller, "start").mockResolvedValue(false);
  expect(button(S.start).props.disabled).toBe(true);
  expect(start).not.toHaveBeenCalled();
  noReads();
  choose(aName);
  clickStart();
  const originalSource = start.mock.calls[0][1][0];
  expect(start.mock.calls[0][1]).toHaveLength(1);
  expect(originalSource.threadKey).toBe("a");
  props = { ...props, rows: [...props.rows].reverse() };
  const view = render();
  clickStart();
  expect(start.mock.calls[1][1]).toEqual([originalSource]);
  expect(start.mock.calls[1][1][0]).toBe(originalSource);
  expect(isCurrent(originalSource)).toBe(true);
  expect(start.mock.calls[1][2]()).toBe(true);
  expect(props.rows.map((row) => row.key).sort()).toEqual(originalKeys);
  expect(h.snapshot.threads.get("a")).toBe(a);
  expect(h.snapshot.threads.get("b")).toBe(b);
  expect(a.items[0]).toBe(aItem);
  expect(aItem.attachments[0]).toBe(attachment);
  expect(h.snapshot.index).toBe(index);
  expect(JSON.stringify([...h.snapshot.threads])).toBe(sourceState);

  const body = text(view.root);
  for (const part of [aName, aTitle, aPath])
    expect
      .soft(body.includes(part), `Selected valid A must expose ${part}`)
      .toBe(true);
  const cancel = removalForA(view);
  expect
    .soft(
      cancel,
      "Selected valid A needs an exposed operable cancellation entry",
    )
    .toBeDefined();
  noReads();
  // An absent control is the old-source failure. Do not cancel by reaching into
  // stale handlers or private component state to manufacture a passing result.
  if (!cancel) return;
  remove(cancel);
  expect(button(S.start).props.disabled).toBe(true);
  expect(isCurrent(originalSource)).toBe(true);
  expect(start.mock.calls[1][2]()).toBe(false);
  choose("b-0.txt");
  clickStart();
  const next = start.mock.calls.at(-1)![1];
  expect(next).toHaveLength(1);
  expect(next[0].threadKey).toBe("b");
  expect(next).not.toContain(originalSource);
  expect(next.some((source) => source.id === originalSource.id)).toBe(false);
  expect(JSON.stringify([...h.snapshot.threads])).toBe(sourceState);
  noReads();
});
