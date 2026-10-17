import { createHash } from "node:crypto";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadState } from "../runtime/session_types";
import type { VerifiedFile } from "../runtime/file_delivery";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  effects: [] as (() => void)[],
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
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => h.snapshot,
  threads: { getSnapshot: () => h.snapshot },
}));
import { SelectedAttachmentSearch } from "./SelectedAttachmentSearch";
import { AttachmentSearch } from "../runtime/attachment_search";
import { freshThreadState } from "../runtime/session_projection";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";

type Element = { type: unknown; props: Record<string, unknown> };
const clearLabel = "清除失效选择";
const text = "needle";
const file = (path: string): VerifiedFile => ({
  root: "/controlled",
  path,
  resolvedPath: path,
  name: path.split("/").at(-1)!,
  size: text.length,
  sha256: createHash("sha256").update(text).digest("hex"),
  version: "first",
});
const calls = {
  inspect: vi.fn(async (path: string) => file(path)),
  read: vi.fn(async (source: VerifiedFile) => ({ file: source, text })),
  check: vi.fn(async (source: VerifiedFile) => ({
    kind: "verified",
    file: source,
  })),
};
let controller: AttachmentSearch;
let props: Parameters<typeof SelectedAttachmentSearch>[0];
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
// Controlled hook commits plus real production component/controller/ownership.
// These tests do not claim browser DOM, layout, native IPC or real file reads.
function render(): Element[] {
  h.cursor = 0;
  const tree = nodes(SelectedAttachmentSearch(props));
  const effects = h.effects.splice(0);
  if (effects.length) {
    effects.forEach((effect) => effect());
    return render();
  }
  return tree;
}
const boxes = (tree = render()) =>
  tree.filter(
    (node) => node.type === "input" && node.props.type === "checkbox",
  );
const button = (label: string, tree = render()) =>
  tree.find((node) => node.type === "button" && node.props.children === label);
function change(index: number, checked = true) {
  const onChange = boxes()[index].props.onChange as (event: {
    target: { checked: boolean };
  }) => void;
  onChange({ target: { checked } });
}
function click(label: string) {
  const target = button(label);
  expect(target, `missing ${label}`).toBeDefined();
  (target!.props.onClick as () => void)();
}
function removeAttachmentA() {
  const item = h.snapshot.threads.get("a")!.items[0];
  if (item.kind !== "user") throw Error("Controlled message missing");
  item.attachments = [];
}
function fixture(key: string) {
  const thread = freshThreadState(
    key,
    "controlled",
    "/controlled",
    `native-${key}`,
  );
  thread.items = [
    {
      kind: "user",
      id: `message-${key}`,
      time: 1,
      streaming: false,
      text: "received",
      attachments: [
        { name: `${key}.txt`, uri: `file:///controlled/${key}.txt` },
      ],
    },
  ];
  return thread;
}
function assertNoReads() {
  expect(calls.inspect).not.toHaveBeenCalled();
  expect(calls.read).not.toHaveBeenCalled();
  expect(calls.check).not.toHaveBeenCalled();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  calls.inspect.mockReset().mockImplementation(async (path) => file(path));
  calls.read
    .mockReset()
    .mockImplementation(async (source) => ({ file: source, text }));
  calls.check
    .mockReset()
    .mockImplementation(async (source) => ({ kind: "verified", file: source }));
  controller = new AttachmentSearch(calls);
  const a = fixture("a"),
    b = fixture("b");
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
      { key: "a", title: "A" },
      { key: "b", title: "B" },
    ] as Parameters<typeof SelectedAttachmentSearch>[0]["rows"],
    query: "needle",
    scopeKey: "all",
    controller,
  };
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
});

it("keeps the stale guard until explicit recovery removes a hidden old-scope selection and keeps valid B", () => {
  change(0);
  change(1);
  props = { ...props, rows: [props.rows[1]], scopeKey: "only-b" };
  expect(button(S.start)!.props.disabled).toBe(true);
  expect(boxes()).toHaveLength(1);
  expect(boxes()[0].props.checked).toBe(true);
  click(clearLabel);
  expect(boxes()).toHaveLength(1);
  expect(boxes()[0].props.checked).toBe(true);
  expect(button(S.start)!.props.disabled).toBe(false);
  expect(button(clearLabel)).toBeUndefined();
  assertNoReads();
});
it("explicitly recovers when an attachment disappears without any scope or row membership change", () => {
  change(0);
  change(1);
  removeAttachmentA();
  expect(button(S.start)!.props.disabled).toBe(true);
  expect(boxes()).toHaveLength(1);
  click(clearLabel);
  expect(boxes()[0].props.checked).toBe(true);
  expect(button(S.start)!.props.disabled).toBe(false);
  assertNoReads();
});
it.each(["changed", "duplicate"])(
  "filters only invalid %s index ownership and retains a valid selection",
  (mode) => {
    change(0);
    change(1);
    if (mode === "changed")
      h.snapshot.index[0] = {
        ...h.snapshot.index[0],
        nativeSessionId: "replacement",
      };
    else h.snapshot.index.push({ ...h.snapshot.index[0] });
    expect(button(S.start)!.props.disabled).toBe(true);
    click(clearLabel);
    expect(boxes().map((node) => node.props.checked)).toEqual([false, true]);
    expect(button(S.start)!.props.disabled).toBe(false);
    assertNoReads();
  },
);
it("clears the last invalid choice without starting or inventing an eligible source", () => {
  change(0);
  removeAttachmentA();
  click(clearLabel);
  expect(boxes().every((node) => node.props.checked === false)).toBe(true);
  expect(button(S.start)!.props.disabled).toBe(true);
  expect(button(clearLabel)).toBeUndefined();
  assertNoReads();
});
it("does not discard still-valid choices for query, same-member scope changes or ordinary rerenders", () => {
  change(0);
  change(1);
  props = {
    ...props,
    query: "other",
    scopeKey: "same-members",
    rows: [...props.rows].reverse(),
  };
  expect(boxes().map((node) => node.props.checked)).toEqual([true, true]);
  expect(button(clearLabel)).toBeUndefined();
  expect(button(S.start)!.props.disabled).toBe(false);
  assertNoReads();
});
it("guards inactive direct callbacks and lets a current click clear only currently invalid choices", () => {
  change(0);
  change(1);
  removeAttachmentA();
  const captured = button(clearLabel);
  expect(captured).toBeDefined();
  props = { ...props, active: false };
  expect(button(clearLabel)!.props.disabled).toBe(true);
  (captured!.props.onClick as () => void)();
  props = { ...props, active: true };
  expect(button(clearLabel)).toBeDefined();
  expect(button(S.start)!.props.disabled).toBe(true);
  click(clearLabel);
  expect(boxes()[0].props.checked).toBe(true);
  expect(button(S.start)!.props.disabled).toBe(false);
  assertNoReads();
});
it("cannot release an in-flight read or display its late result through recovery", async () => {
  let resolve!: (source: VerifiedFile) => void;
  calls.inspect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const started = vi.spyOn(controller, "start");
  change(0);
  click(S.start);
  expect(controller.active()).toBe(true);
  const owner = started.mock.calls[0][2];
  removeAttachmentA();
  const clear = button(clearLabel);
  expect(clear).toBeDefined();
  expect(clear!.props.disabled).toBe(true);
  (clear!.props.onClick as () => void)();
  expect(controller.active()).toBe(true);
  expect(owner()).toBe(false);
  resolve(file("/controlled/a.txt"));
  await vi.waitFor(() => expect(controller.active()).toBe(false));
  expect(controller.snapshot().hits).toEqual([]);
  expect(calls.read).not.toHaveBeenCalled();
  change(0);
  click(clearLabel);
  expect(boxes()[0].props.checked).toBe(true);
  expect(button(S.start)!.props.disabled).toBe(false);
  expect(calls.inspect).toHaveBeenCalledTimes(1);
});
it("recovery keeps an unknown prior read pending and never retries it automatically", async () => {
  calls.inspect.mockRejectedValueOnce({ code: "pending" });
  change(0);
  click(S.start);
  await vi.waitFor(() => expect(controller.snapshot().phase).toBe("pending"));
  removeAttachmentA();
  change(0);
  click(clearLabel);
  expect(controller.snapshot().phase).toBe("pending");
  expect(boxes()[0].props.checked).toBe(true);
  expect(calls.inspect).toHaveBeenCalledTimes(1);
  expect(calls.read).not.toHaveBeenCalled();
});
it("a completed old hit and captured owner stay retired after explicitly clearing invalid sources", async () => {
  const started = vi.spyOn(controller, "start");
  change(0);
  click(S.start);
  await vi.waitFor(() => expect(controller.snapshot().phase).toBe("complete"));
  const hit = controller.snapshot().hits[0],
    oldOwner = started.mock.calls[0][2];
  expect(hit).toBeDefined();
  removeAttachmentA();
  change(0);
  click(clearLabel);
  expect(oldOwner()).toBe(false);
  expect(controller.snapshot().hits).toEqual([]);
  expect(await controller.verifyHit(hit, oldOwner)).toBe(false);
  expect(calls.inspect).toHaveBeenCalledTimes(1);
  expect(calls.read).toHaveBeenCalledTimes(1);
  expect(calls.check).toHaveBeenCalledTimes(1);
});

function focusTarget(activeElement: HTMLButtonElement | null) {
  const fieldset = render().find((node) => node.type === "fieldset")!;
  const focus = vi.fn();
  const ref = fieldset.props.ref as
    { current: HTMLFieldSetElement | null } | undefined;
  if (ref)
    ref.current = {
      ownerDocument: { activeElement },
      focus,
    } as unknown as HTMLFieldSetElement;
  return { fieldset, focus };
}
function stalePair() {
  change(0);
  change(1);
  removeAttachmentA();
}
it("moves owned recovery-button focus to the stable fieldset before retiring the selection", () => {
  stalePair();
  const target = {} as HTMLButtonElement;
  const { fieldset, focus } = focusTarget(target);
  const order: string[] = [];
  focus.mockImplementation(() => order.push("focus"));
  const retire = controller.retire.bind(controller);
  vi.spyOn(controller, "retire").mockImplementation(() => {
    order.push("retire");
    retire();
  });
  (
    button(clearLabel)!.props.onClick as (event: {
      currentTarget: HTMLButtonElement;
    }) => void
  )({ currentTarget: target });
  expect(focus).toHaveBeenCalledOnce();
  expect(order.slice(0, 2)).toEqual(["focus", "retire"]);
  expect(fieldset.props.tabIndex).toBe(-1);
  expect(boxes()[0].props.checked).toBe(true);
  assertNoReads();
});
it("does not steal focus moved from the recovery button to another control", () => {
  stalePair();
  const target = {} as HTMLButtonElement;
  const { focus } = focusTarget({} as HTMLButtonElement);
  (
    button(clearLabel)!.props.onClick as (event: {
      currentTarget: HTMLButtonElement;
    }) => void
  )({ currentTarget: target });
  expect(focus).not.toHaveBeenCalled();
  expect(boxes()[0].props.checked).toBe(true);
  expect(button(S.start)!.props.disabled).toBe(false);
  assertNoReads();
});
it("does not require a DOM ref for controlled recovery", () => {
  stalePair();
  expect(() => click(clearLabel)).not.toThrow();
  expect(boxes()[0].props.checked).toBe(true);
  assertNoReads();
});
