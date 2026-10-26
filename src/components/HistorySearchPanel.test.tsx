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
  indexListeners: new Set<() => void>(),
  authentication: new Set<(agentId: string) => void>(),
  credentials: new Set<() => void>(),
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
    subscribe: (listener: () => void) => {
      hooks.indexListeners.add(listener);
      return () => hooks.indexListeners.delete(listener);
    },
  },
  useThreadsSnapshot: () => ({ index: hooks.index, threads: hooks.threads }),
}));
vi.mock("../runtime/authentication", async (original) => ({
  ...(await original<typeof import("../runtime/authentication")>()),
  subscribeAuthenticationChanges: (listener: (agentId: string) => void) => {
    hooks.authentication.add(listener);
    return () => hooks.authentication.delete(listener);
  },
}));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  subscribeCredentialChanges: (listener: () => void) => {
    hooks.credentials.add(listener);
    return () => hooks.credentials.delete(listener);
  },
}));
import { HistorySearchPanel } from "./HistorySearchPanel";
import { HistorySearchResults } from "./HistorySearchResults";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { HISTORY_SEARCH_STRINGS as S } from "../runtime/history_search_strings";
import { HistorySearchController } from "../runtime/history_search_controller";
import type {
  HistoryReadInput,
  HistoryReadOperation,
} from "../runtime/history_search_types";
import {
  setup,
  selection,
  operation,
  flush,
  deferred,
} from "../runtime/history_search.test-support";
import {
  sdkSelection,
  sdkOperation,
} from "../runtime/history_search.sdk.test-support";
let h: ReturnType<typeof setup>,
  active = true,
  query = "hello",
  owners = new Map<string, object>(),
  rows: SidebarRow[] = [];
const onOpen = vi.fn();

function returnedRead(): HistoryReadOperation {
  return {
    agentId: "fixture",
    requestId: "00000000-0000-4000-8000-000000000003",
    source: "officialSessionLoad",
    query: "hello",
    rowIds: ["saved-1"],
    scope: "userAndAssistantText",
    coverageScope: "acknowledgedLoadPrefix",
    textScope: "returnedVisibleFields",
    matchMode: "ecmascriptUnicodeLiteral",
    exclusions: ["attachments", "toolOutput", "reasoning", "otherMessageKinds"],
    state: "finished",
    settled: true,
    code: null,
    rows: [
      {
        rowId: "saved-1",
        coverage: "completeReturnedPrefix",
        textBlocksRead: 1,
        matchedTextBlocks: 1,
        skippedFields: 0,
        sourceStatus: "sourceUnconfirmed",
        code: null,
      },
    ],
    hits: [
      {
        rowId: "saved-1",
        role: "user",
        text: "hello from the returned prefix",
        textTruncated: false,
        matches: [{ start: 0, end: 5 }],
        matchesTruncated: false,
        locator: { kind: "returnedText", blockIndex: 0, fieldIndex: 0 },
      },
    ],
    pendingCleanup: null,
  };
}
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
  hooks.indexListeners.clear();
  hooks.authentication.clear();
  hooks.credentials.clear();
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
it("explicitly reads only the selected indexed body without borrowing native search admission", async () => {
  const result = returnedRead();
  const read = vi.fn(async (_input: HistoryReadInput) => result);
  // Constructor injection is the consumer boundary. The existing constructor
  // safely ignores the extra argument before this feature is implemented.
  h.controller = Reflect.construct(HistorySearchController, [
    h.port,
    () => result.requestId,
    () => 0,
    100,
    read,
  ]) as HistorySearchController;
  choose();
  click("读取所选正文");
  await flush();
  expect(read).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: "fixture",
      query: "hello",
      targets: [
        {
          rowId: "saved-1",
          agentId: "fixture",
          cwd: "/owned",
          nativeSessionId: "native-1",
          unavailable: null,
        },
      ],
    }),
  );
  expect(h.port.capabilities).not.toHaveBeenCalled();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(h.port.status).not.toHaveBeenCalled();
  expect(h.port.cancel).not.toHaveBeenCalled();
  expect(h.port.release).not.toHaveBeenCalled();
  expect(
    nodes().find((node) => node.type === HistorySearchResults)?.props.operation,
  ).toEqual(result);
  expect(onOpen).not.toHaveBeenCalled();
});
it("keeps exact selected facts usable across title and clock-only index refresh", async () => {
  await start();
  hooks.index = [
    {
      ...(hooks.index[0] as IndexRow),
      title: "Renamed without changing the target",
      updatedAt: 2,
    },
  ];
  rows = [
    { ...rows[0], title: "Renamed without changing the target", updatedAt: 2 },
  ];
  render();
  const result = operation("completed", 3);
  h.start.resolve(result);
  await flush();
  expect(h.port.cancel).not.toHaveBeenCalled();
  expect(
    nodes().find((node) => node.type === HistorySearchResults)?.props.operation,
  ).toEqual(result.operation);
  expect(h.port.start).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});
it("shows a returned match but cannot open its original while another selected read is unsettled", async () => {
  hooks.index.push({
    ...(hooks.index[0] as IndexRow),
    id: "saved-2",
    nativeSessionId: "native-2",
  });
  rows.push({ ...rows[0], key: "saved-2", nativeSessionId: "native-2" });
  const pending = deferred<HistoryReadOperation>();
  let input!: HistoryReadInput;
  const read = vi.fn((next: HistoryReadInput) => {
    input = next;
    return pending.promise;
  });
  h.controller = new HistorySearchController(
    h.port,
    () => returnedRead().requestId,
    () => 0,
    100,
    read,
  );
  choose();
  const second = nodes().filter(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )[1];
  (second.props.onChange as Function)({ target: { checked: true } });
  render();
  click(S.readSelected);
  await flush();
  const progress: HistoryReadOperation = {
    ...returnedRead(),
    rowIds: ["saved-1", "saved-2"],
    state: "reading",
    settled: false,
    rows: [
      returnedRead().rows[0],
      {
        ...returnedRead().rows[0],
        rowId: "saved-2",
        coverage: "reading",
        textBlocksRead: 0,
        matchedTextBlocks: 0,
        sourceStatus: "notRead",
      },
    ],
  };
  input.onProgress(progress);
  const results = nodes().find((node) => node.type === HistorySearchResults)!;
  (results.props.onPreview as Function)(progress.hits[0]);
  const early = nodes().find(
    (node) =>
      node.type === "button" && node.props.children === S.openConversation,
  )!;
  expect(early.props.disabled).toBe(true);
  (early.props.onClick as Function)();
  expect(onOpen).not.toHaveBeenCalled();
  hooks.index = hooks.index.map((row) => ({
    ...(row as IndexRow),
    title: "Title refreshed",
    updatedAt: 9,
  }));
  rows = rows.map((row) => ({
    ...row,
    title: "Title refreshed",
    updatedAt: 9,
  }));
  render();
  expect(input.current()).toBe(true);
  pending.resolve({
    ...progress,
    state: "finished",
    settled: true,
    rows: [
      progress.rows[0],
      {
        ...progress.rows[1],
        coverage: "completeEmpty",
        sourceStatus: "sourceUnconfirmed",
      },
    ],
  });
  await flush();
  render();
  click(S.openConversation);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(rows[0]);
  expect(read).toHaveBeenCalledTimes(1);
  for (const method of Object.values(h.port))
    expect(method).not.toHaveBeenCalled();
});
it("hides retained hits during pending exact close and rejects a previously captured open action", async () => {
  const pending = deferred<HistoryReadOperation>();
  let input!: HistoryReadInput;
  h.controller = new HistorySearchController(
    h.port,
    () => returnedRead().requestId,
    () => 0,
    100,
    (next) => {
      input = next;
      return pending.promise;
    },
  );
  choose();
  click(S.readSelected);
  await flush();
  const progress = {
    ...returnedRead(),
    state: "reading" as const,
    settled: false,
  };
  input.onProgress(progress);
  (
    nodes().find((node) => node.type === HistorySearchResults)!.props
      .onPreview as Function
  )(progress.hits[0]);
  const captured = nodes().find(
    (node) =>
      node.type === "button" && node.props.children === S.openConversation,
  )!.props.onClick as Function;
  const blocked: HistoryReadOperation = {
    ...progress,
    state: "pendingCleanup",
    code: "pendingCleanup",
    pendingCleanup: {
      rowId: "saved-1",
      receipt: {
        agentId: "fixture",
        cwd: "/owned",
        nativeSessionId: "native-1",
        previewToken: "owned-token",
      },
    },
  };
  pending.resolve(blocked);
  await flush();
  render();
  captured();
  expect(onOpen).not.toHaveBeenCalled();
  expect(nodes().some((node) => node.type === WorkspaceDialog)).toBe(false);
  expect(
    nodes().find((node) => node.type === HistorySearchResults)?.props.operation,
  ).toMatchObject({ hits: [] });
  expect(
    nodes().some(
      (node) =>
        node.type === "button" && node.props.children === S.readRetryClose,
    ),
  ).toBe(true);
  expect(
    nodes().some(
      (node) => node.type === "button" && node.props.children === S.check,
    ),
  ).toBe(false);
  for (const method of Object.values(h.port))
    expect(method).not.toHaveBeenCalled();
});
it("related saved-source A-B-A changes retire a selected read and cannot revive late body", async () => {
  const original = hooks.index[0] as IndexRow;
  const a = {
    _farfoldService: {
      kind: "configured",
      identity: {
        id: "controlled-a",
        fingerprint: "controlled-source",
        model: "controlled-model",
      },
    },
  };
  hooks.index = [{ ...original, configOptions: a }];
  const pending = deferred<HistoryReadOperation>();
  let input!: HistoryReadInput;
  h.controller = new HistorySearchController(
    h.port,
    () => returnedRead().requestId,
    () => 0,
    100,
    (next) => {
      input = next;
      return pending.promise;
    },
  );
  choose();
  click(S.readSelected);
  await flush();
  hooks.index = [
    { ...original, configOptions: { _farfoldService: { kind: "existing" } } },
  ];
  render();
  hooks.index = [{ ...original, configOptions: a }];
  render();
  expect(input.current()).toBe(false);
  expect(input.signal.aborted).toBe(true);
  pending.resolve(returnedRead());
  await flush();
  expect(nodes().some((node) => node.type === HistorySearchResults)).toBe(
    false,
  );
  expect(h.controller.get("fixture").flight?.operation?.hits).toEqual([]);
  expect(onOpen).not.toHaveBeenCalled();
  expect(h.port.cancel).not.toHaveBeenCalled();
});
it("a captured returned-text source action cannot open a replaced indexed owner", async () => {
  const result = returnedRead();
  h.controller = new HistorySearchController(
    h.port,
    () => result.requestId,
    () => 0,
    100,
    async () => result,
  );
  choose();
  click(S.readSelected);
  await flush();
  (
    nodes().find((node) => node.type === HistorySearchResults)!.props
      .onPreview as Function
  )(result.hits[0]);
  const captured = nodes().find(
    (node) =>
      node.type === "button" && node.props.children === S.openConversation,
  )!.props.onClick as Function;
  hooks.index = [
    { ...(hooks.index[0] as IndexRow), cwd: "/different-controlled-owner" },
  ];
  captured();
  expect(onOpen).not.toHaveBeenCalled();
  expect(h.port.cancel).not.toHaveBeenCalled();
});
it("hiding the selected-read view keeps its exact original observation and drops late body", async () => {
  const pending = deferred<HistoryReadOperation>();
  let input!: HistoryReadInput;
  const read = vi.fn((next: HistoryReadInput) => {
    input = next;
    return pending.promise;
  });
  h.controller = new HistorySearchController(
    h.port,
    () => returnedRead().requestId,
    () => 0,
    100,
    read,
  );
  choose();
  click(S.readSelected);
  await flush();
  active = false;
  render();
  expect(input.signal.aborted).toBe(true);
  pending.resolve(returnedRead());
  await flush();
  active = true;
  render();
  expect(nodes().some((node) => node.type === HistorySearchResults)).toBe(
    false,
  );
  expect(nodes().some((node) => node.type === WorkspaceDialog)).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  expect(h.port.cancel).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});
it.each(["authentication", "credentials", "related-index"] as const)(
  "%s changes retire a read immediately, including same-value return before another render",
  async (kind) => {
    const pending = deferred<HistoryReadOperation>();
    let input!: HistoryReadInput;
    const read = vi.fn((next: HistoryReadInput) => {
      input = next;
      return pending.promise;
    });
    h.controller = new HistorySearchController(
      h.port,
      () => returnedRead().requestId,
      () => 0,
      100,
      read,
    );
    choose();
    click(S.readSelected);
    await flush();
    if (kind === "authentication")
      hooks.authentication.forEach((listener) => listener("fixture"));
    else if (kind === "credentials")
      hooks.credentials.forEach((listener) => listener());
    else {
      const original = hooks.index;
      hooks.index = [
        { ...(hooks.index[0] as IndexRow), cwd: "/changed-controlled-owner" },
      ];
      hooks.indexListeners.forEach((listener) => listener());
      hooks.index = original;
      hooks.indexListeners.forEach((listener) => listener());
    }
    expect(input.current()).toBe(false);
    expect(input.signal.aborted).toBe(true);
    render();
    pending.resolve(returnedRead());
    await flush();
    expect(nodes().some((node) => node.type === HistorySearchResults)).toBe(
      false,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(h.port.cancel).not.toHaveBeenCalled();
  },
);
it("an unrelated Agent authentication change keeps the selected read current", async () => {
  const pending = deferred<HistoryReadOperation>();
  let input!: HistoryReadInput;
  h.controller = new HistorySearchController(
    h.port,
    () => returnedRead().requestId,
    () => 0,
    100,
    (next) => {
      input = next;
      return pending.promise;
    },
  );
  choose();
  click(S.readSelected);
  await flush();
  hooks.authentication.forEach((listener) =>
    listener("another-controlled-agent"),
  );
  render();
  expect(input.current()).toBe(true);
  expect(input.signal.aborted).toBe(false);
  const result = returnedRead();
  pending.resolve(result);
  await flush();
  expect(
    nodes().find((node) => node.type === HistorySearchResults)?.props.operation,
  ).toEqual(result);
  expect(onOpen).not.toHaveBeenCalled();
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
it("prepare explains a selected history becoming loaded without reading its original scope", async () => {
  choose();
  const indexed = hooks.index[0];
  hooks.threads.set("saved-1", {});
  render();
  click(S.prepare);
  await flush();
  const rendered = nodes();
  expect(hooks.index[0]).toBe(indexed);
  expect(h.port.capabilities).not.toHaveBeenCalled();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(
    rendered.some(
      (node) => node.props.role === "alert" && node.props.children === S.stale,
    ),
  ).toBe(true);
});
it("an unrelated loaded conversation leaves a valid explicit history selection usable", async () => {
  choose();
  hooks.index = [
    ...hooks.index,
    { ...(hooks.index[0] as IndexRow), id: "another" },
  ];
  hooks.threads.set("another", {});
  render();
  click(S.prepare);
  await flush();
  expect(h.port.capabilities).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    rowIds: ["saved-1"],
  });
  expect(h.port.start).not.toHaveBeenCalled();
  expect(query).toBe("hello");
  expect(onOpen).not.toHaveBeenCalled();
});
it.each([true, false])(
  "removing stale history selection preserves valid rows and query, focused recovery=%s",
  async (focused) => {
    hooks.index.push({
      ...(hooks.index[0] as IndexRow),
      id: "saved-2",
      nativeSessionId: "native-2",
    });
    rows.push({ ...rows[0], key: "saved-2", nativeSessionId: "native-2" });
    choose();
    const checkboxes = nodes().filter(
      (node) => node.type === "input" && node.props.type === "checkbox",
    );
    (checkboxes[1].props.onChange as Function)({ target: { checked: true } });
    render();
    hooks.threads.set("saved-1", {});
    render();
    click(S.prepare);
    await flush();
    expect(h.port.capabilities).not.toHaveBeenCalled();
    const rendered = nodes();
    const recovery = rendered.find(
      (node) =>
        node.type === "button" &&
        node.props.children === S.clearInvalidSelection,
    )!;
    expect(recovery).toBeDefined();
    expect(recovery.props.disabled).not.toBe(true);
    const fieldset = rendered.find((node) => node.type === "fieldset")!;
    const focus = vi.fn();
    const button = {};
    (fieldset.props.ref as { current: unknown }).current = {
      focus,
      ownerDocument: { activeElement: focused ? button : {} },
    };
    (recovery.props.onClick as Function)({ currentTarget: button });
    const current = nodes();
    expect(focus).toHaveBeenCalledTimes(focused ? 1 : 0);
    expect(fieldset.props.tabIndex).toBe(-1);
    expect(
      current
        .filter(
          (node) => node.type === "input" && node.props.type === "checkbox",
        )
        .map((node) => node.props.checked),
    ).toEqual([false, true]);
    expect(current.some((node) => node.props.children === S.stale)).toBe(false);
    expect(h.port.capabilities).not.toHaveBeenCalled();
    expect(h.port.start).not.toHaveBeenCalled();
    const prepared = selection();
    prepared.rows[0].rowId = "saved-2";
    h.port.capabilities.mockResolvedValue(prepared);
    click(S.prepare);
    await flush();
    expect(h.port.capabilities).toHaveBeenCalledExactlyOnceWith({
      agentId: "fixture",
      rowIds: ["saved-2"],
    });
    click(S.start);
    await flush();
    expect(h.port.start).toHaveBeenCalledTimes(1);
    expect(h.controller.get("fixture").flight?.expected).toMatchObject({
      rowIds: ["saved-2"],
      query: "hello",
    });
    expect(onOpen).not.toHaveBeenCalled();
  },
);
it("a captured prepare explains a just-loaded source before the next render without reading it", async () => {
  choose();
  const prepare = nodes().find(
    (node) => node.type === "button" && node.props.children === S.prepare,
  )!.props.onClick as Function;
  hooks.threads.set("saved-1", {});
  prepare();
  await flush();
  render();
  expect(h.port.capabilities).not.toHaveBeenCalled();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(
    nodes().some(
      (node) => node.props.role === "alert" && node.props.children === S.stale,
    ),
  ).toBe(true);
});
it("returning a temporarily loaded row to unread history creates a usable fresh scope", async () => {
  choose();
  hooks.threads.set("saved-1", {});
  render();
  click(S.prepare);
  await flush();
  expect(h.port.capabilities).not.toHaveBeenCalled();
  hooks.threads.delete("saved-1");
  render();
  click(S.prepare);
  await flush();
  expect(h.port.capabilities).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    rowIds: ["saved-1"],
  });
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
it("a retired prepare callback cannot write a stale warning into a valid successor scope", async () => {
  choose();
  const oldPrepare = nodes().find(
    (node) => node.type === "button" && node.props.children === S.prepare,
  )!.props.onClick as Function;
  query = "current query";
  render();
  oldPrepare();
  await flush();
  expect(
    nodes().some(
      (node) => node.props.role === "alert" && node.props.children === S.stale,
    ),
  ).toBe(false);
  expect(h.port.capabilities).not.toHaveBeenCalled();
  click(S.prepare);
  await flush();
  expect(h.port.capabilities).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    rowIds: ["saved-1"],
  });
  expect(h.port.start).not.toHaveBeenCalled();
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

it("declares the limited registered-ID scope before explicit reading, with no automatic open", async () => {
  h.port.capabilities.mockResolvedValue(sdkSelection());
  choose();
  click(S.prepare);
  await flush();
  expect(nodes().some((n) => n.props.children === S.registeredScope)).toBe(
    true,
  );
  expect(nodes().some((n) => n.props.children === S.registeredCheck)).toBe(
    true,
  );
  expect(h.port.start).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});
it("previews SDK text without inventing message navigation and protects original opening", async () => {
  h.port.capabilities.mockResolvedValue(sdkSelection());
  await start();
  const result = sdkOperation();
  h.start.resolve(result);
  await flush();
  (
    nodes().find((n) => n.type === HistorySearchResults)!.props
      .onPreview as Function
  )(result.operation.hits[0]);
  expect(nodes().some((n) => n.props.children === S.registeredOpen)).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  const open = nodes().find(
    (n) => n.type === "button" && n.props.children === S.openConversation,
  )!.props.onClick as Function;
  hooks.index = [
    { ...(hooks.index[0] as IndexRow), nativeSessionId: "changed" },
  ];
  open();
  expect(onOpen).not.toHaveBeenCalled();
});
it("keeps a partial-route preview's original opening a separate explicit action", async () => {
  h.port.capabilities.mockResolvedValue(sdkSelection());
  await start();
  const result = sdkOperation();
  h.start.resolve(result);
  await flush();
  (
    nodes().find((n) => n.type === HistorySearchResults)!.props
      .onPreview as Function
  )(result.operation.hits[0]);
  click(S.openConversation);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(rows[0]);
  expect(h.port.start).toHaveBeenCalledTimes(1);
});
