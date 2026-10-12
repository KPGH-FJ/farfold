import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import type { IndexRow, SidebarRow } from "../runtime/sessions";
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  memos: [] as { deps: unknown[]; value: unknown }[],
  effects: [] as {
    deps: unknown[] | undefined;
    fn: () => unknown;
    cleanup?: () => void;
  }[],
  pending: [] as (() => void)[],
  s: 0,
  r: 0,
  m: 0,
  e: 0,
  index: [] as unknown[],
  threads: new Map(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = hooks.s++;
    if (i >= hooks.states.length)
      hooks.states.push(typeof initial === "function" ? initial() : initial);
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] =
          typeof value === "function" ? value(hooks.states[i]) : value;
      },
    ];
  },
  useRef: (current: unknown) => (hooks.refs[hooks.r++] ??= { current }),
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = hooks.m++;
    if (
      !hooks.memos[i] ||
      deps.some((d, j) => !Object.is(d, hooks.memos[i].deps[j]))
    )
      hooks.memos[i] = { deps, value: fn() };
    return hooks.memos[i].value;
  },
  useEffect: (fn: () => unknown, deps?: unknown[]) => {
    const i = hooks.e++;
    if (
      !hooks.effects[i] ||
      !deps ||
      deps.some((d, j) => !Object.is(d, hooks.effects[i].deps?.[j]))
    )
      hooks.pending.push(() => {
        hooks.effects[i]?.cleanup?.();
        hooks.effects[i] = {
          deps,
          fn,
          cleanup: fn() as (() => void) | undefined,
        };
      });
  },
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
}));
vi.mock("../runtime/sessions", () => ({
  threads: {
    getSnapshot: () => ({ index: hooks.index, threads: hooks.threads }),
  },
  useThreadsSnapshot: () => ({ index: hooks.index, threads: hooks.threads }),
}));
import { HistorySearchPanel } from "./HistorySearchPanel";
import { HistorySearchResults } from "./HistorySearchResults";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { HISTORY_SEARCH_STRINGS as S } from "../runtime/history_search_strings";
import {
  setup,
  operation,
  flush,
} from "../runtime/history_search.test-support";
let h: ReturnType<typeof setup>,
  active = true,
  query = "hello",
  owners = new Map<string, object>(),
  rows: SidebarRow[] = [];
const onOpen = vi.fn();
function render() {
  hooks.s = hooks.r = hooks.m = hooks.e = 0;
  const tree = HistorySearchPanel({
    active,
    query,
    agents: [],
    agentOwners: owners,
    rows,
    onOpen,
    controller: h.controller,
  });
  const pending = hooks.pending.splice(0);
  pending.forEach((fn) => fn());
  return tree;
}
function nodes(
  tree: ReactNode = render(),
): { type: unknown; props: Record<string, unknown> }[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          { type: child.type, props: child.props },
          ...(child.props.children === undefined
            ? []
            : nodes(child.props.children as ReactNode)),
        ]
      : [],
  );
}
const click = (label: string) => {
  const n = nodes().find(
    (n) => n.type === "button" && n.props.children === label,
  );
  expect(n).toBeDefined();
  expect(n!.props.disabled).not.toBe(true);
  (n!.props.onClick as () => void)();
};
function choose() {
  render();
  (nodes().find((n) => n.type === "select")!.props.onChange as Function)({
    target: { value: "fixture" },
  });
  render();
  (
    nodes().find((n) => n.type === "input" && n.props.type === "checkbox")!
      .props.onChange as Function
  )({ target: { checked: true } });
  render();
}
async function start() {
  choose();
  click(S.prepare);
  await flush();
  render();
  click(S.start);
  await flush();
  render();
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.states = [];
  hooks.refs = [];
  hooks.memos = [];
  hooks.effects = [];
  hooks.pending = [];
  hooks.threads = new Map();
  hooks.index = [
    {
      id: "saved-1",
      agentId: "fixture",
      cwd: "/owned",
      nativeSessionId: "native-1",
      title: "Saved",
      configOptions: null,
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    } satisfies IndexRow,
  ];
  h = setup();
  active = true;
  query = "hello";
  owners = new Map([["fixture", {}]]);
  rows = [
    {
      key: "saved-1",
      agentId: "fixture",
      cwd: "/owned",
      nativeSessionId: "native-1",
      title: "Saved",
      pinned: false,
      archived: false,
      updatedAt: 1,
      status: "idle",
      live: false,
      source: "meta",
    },
  ];
  onOpen.mockReset();
});
afterEach(() => {
  hooks.effects.forEach((e) => e.cleanup?.());
  vi.useRealTimers();
});
it("mount, choose and capability checks never restore history or start a read", async () => {
  choose();
  expect(h.port.capabilities).not.toHaveBeenCalled();
  expect(h.port.start).not.toHaveBeenCalled();
  click(S.prepare);
  await flush();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});
it("loaded conversations stay explicitly unavailable and cannot be selected", () => {
  hooks.threads.set("saved-1", {});
  render();
  (nodes().find((n) => n.type === "select")!.props.onChange as Function)({
    target: { value: "fixture" },
  });
  const checkbox = nodes().find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  )!;
  expect(checkbox.props.disabled).toBe(true);
  expect(h.port.start).not.toHaveBeenCalled();
});
it("hide while a read is pending exact-cancels and late text cannot reopen a context", async () => {
  await start();
  active = false;
  render();
  expect(h.port.cancel).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    requestId: h.controller.get("fixture").flight!.expected.requestId,
  });
  h.start.resolve(operation("completed", 3));
  await flush();
  active = true;
  expect(nodes().some((n) => n.type === HistorySearchResults)).toBe(false);
  expect(nodes().some((n) => n.type === WorkspaceDialog)).toBe(false);
  expect(h.controller.get("fixture").flight?.operation?.hits).toEqual([]);
  expect(onOpen).not.toHaveBeenCalled();
});
it("program A-B-A and query changes retire original selection without automatically restarting", async () => {
  await start();
  const a = owners.get("fixture")!;
  owners = new Map([["fixture", {}]]);
  render();
  owners = new Map([["fixture", a]]);
  render();
  h.start.resolve(operation("completed", 3));
  await flush();
  expect(nodes().some((n) => n.type === HistorySearchResults)).toBe(false);
  expect(h.port.start).toHaveBeenCalledTimes(1);
  expect(h.controller.get("fixture").flight?.owner).toBeNull();
});
it("a row becoming loaded retires the original read even without an index-object change", async () => {
  await start();
  hooks.threads.set("saved-1", {});
  render();
  expect(h.port.cancel).toHaveBeenCalledTimes(1);
  expect(h.controller.get("fixture").flight?.owner).toBeNull();
});
it("a hit first opens isolated context and only a second explicit action opens the original", async () => {
  await start();
  const result = operation("completed", 3);
  h.start.resolve(result);
  await flush();
  const results = nodes().find((n) => n.type === HistorySearchResults)!;
  (results.props.onPreview as Function)(result.operation.hits[0]);
  expect(nodes().some((n) => n.type === WorkspaceDialog)).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  click(S.openConversation);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(rows[0]);
  expect(h.port.start).toHaveBeenCalledTimes(1);
});
it("a stale captured context action cannot open a replaced index row", async () => {
  await start();
  const result = operation("completed", 3);
  h.start.resolve(result);
  await flush();
  (
    nodes().find((n) => n.type === HistorySearchResults)!.props
      .onPreview as Function
  )(result.operation.hits[0]);
  const action = nodes().find(
    (n) => n.type === "button" && n.props.children === S.openConversation,
  )!.props.onClick as Function;
  hooks.index = [{ ...(hooks.index[0] as IndexRow), cwd: "/replaced" }];
  action();
  expect(onOpen).not.toHaveBeenCalled();
});
it("same pending observation is retained across strict effect cleanup and replay", async () => {
  await start();
  hooks.effects.forEach((e) => e.cleanup?.());
  hooks.effects.forEach((e) => {
    e.cleanup = e.fn() as (() => void) | undefined;
  });
  h.start.resolve(operation("completed", 3));
  await flush();
  expect(h.port.start).toHaveBeenCalledTimes(1);
  expect(h.controller.get("fixture").flight?.operation?.hits).toEqual([]);
  expect(onOpen).not.toHaveBeenCalled();
});
it("unrelated index additions do not retire exact unchanged selected rows", async () => {
  await start();
  hooks.index = [
    ...hooks.index,
    { ...(hooks.index[0] as IndexRow), id: "another" },
  ];
  render();
  expect(h.port.cancel).not.toHaveBeenCalled();
  h.start.resolve(operation("completed", 3));
  await flush();
  expect(nodes().some((n) => n.type === HistorySearchResults)).toBe(true);
});
it("captured old check/cancel handlers cannot act on a successor search for the same Agent", async () => {
  await start();
  const oldCheck = nodes().find(
    (n) => n.type === "button" && n.props.children === S.check,
  )!.props.onClick as Function;
  const oldCancel = nodes().find(
    (n) => n.type === "button" && n.props.children === S.cancel,
  )!.props.onClick as Function;
  h.start.resolve(operation("completed", 3));
  await flush();
  click(S.dismiss);
  await flush();
  render();
  h.port.start.mockReturnValueOnce(new Promise(() => {}));
  click(S.prepare);
  await flush();
  render();
  click(S.start);
  render();
  expect(h.port.start).toHaveBeenCalledTimes(2);
  oldCheck();
  oldCancel();
  expect(h.port.status).not.toHaveBeenCalled();
  expect(h.port.cancel).not.toHaveBeenCalled();
});
it("captured old prepare cannot revive a retired scope after selection changes", async () => {
  choose();
  const oldPrepare = nodes().find(
    (n) => n.type === "button" && n.props.children === S.prepare,
  )!.props.onClick as Function;
  (
    nodes().find((n) => n.type === "input" && n.props.type === "checkbox")!
      .props.onChange as Function
  )({ target: { checked: false } });
  render();
  oldPrepare();
  await flush();
  expect(h.port.capabilities).not.toHaveBeenCalled();
});
it("captured old dismiss cannot release a successor's finished result", async () => {
  await start();
  h.start.resolve(operation("completed", 3));
  await flush();
  const oldDismiss = nodes().find(
    (n) => n.type === "button" && n.props.children === S.dismiss,
  )!.props.onClick as Function;
  click(S.dismiss);
  await flush();
  render();
  const result = operation("completed", 3);
  result.operation.requestId = "00000000-0000-4000-8000-000000000002";
  h.port.start.mockResolvedValueOnce(result);
  click(S.prepare);
  await flush();
  render();
  click(S.start);
  await flush();
  render();
  oldDismiss();
  await flush();
  expect(h.port.release).toHaveBeenCalledTimes(1);
  expect(h.controller.get("fixture").flight?.operation?.requestId).toBe(
    result.operation.requestId,
  );
});

it.each(["completed", "cancelled", "failed", "closed"] as const)(
  "returning to a retired %s result does not suggest unavailable active controls",
  async (state) => {
    await start();
    active = false;
    render();
    expect(h.port.cancel).toHaveBeenCalledTimes(1);
    if (state === "closed") {
      const { agentId, requestId } =
        h.controller.get("fixture").flight!.expected;
      h.cancel.resolve({
        kind: "absent",
        agentId,
        requestId,
        scope: "currentProcess",
        admissionClosed: true,
      });
    } else h.start.resolve(operation(state, 3));
    await flush();
    active = true;
    const rendered = nodes();
    expect(rendered.some((n) => n.props.children === S.retained)).toBe(false);
    expect(rendered.some((n) => n.props.children === S.dismiss)).toBe(true);
    expect(rendered.some((n) => n.props.children === S.check)).toBe(false);
    expect(rendered.some((n) => n.props.children === S.cancel)).toBe(false);
    expect(h.port.start).toHaveBeenCalledTimes(1);
  },
);
it("returning to an unsettled retired read keeps exact status and cancel guidance", async () => {
  await start();
  active = false;
  render();
  active = true;
  const rendered = nodes();
  expect(rendered.some((n) => n.props.children === S.retained)).toBe(true);
  expect(rendered.some((n) => n.props.children === S.check)).toBe(true);
  expect(rendered.some((n) => n.props.children === S.cancel)).toBe(true);
  expect(rendered.some((n) => n.props.children === S.dismiss)).toBe(false);
  expect(h.port.start).toHaveBeenCalledTimes(1);
});
