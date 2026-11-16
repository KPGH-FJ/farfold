import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ComponentProps,
  type MouseEvent,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  runEffects: true,
  invoke: vi.fn(),
  rows: [] as import("../runtime/sidebar").SidebarRow[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value:
        typeof initial === "function" ? (initial as () => unknown)() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (value: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useMemo: (read: () => unknown) => read(),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const old = h.slots[index];
    if (
      h.runEffects &&
      (!old || deps.some((value, i) => !Object.is(value, old.deps?.[i])))
    ) {
      h.effects.push(() => {
        old?.cleanup?.();
        const cleanup = effect();
        if (cleanup) h.slots[index].cleanup = cleanup;
      });
    }
    h.slots[index] = { deps, cleanup: old?.cleanup };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("../runtime/collections", async (original) => ({
  ...(await original<typeof import("../runtime/collections")>()),
  useCollections: () => ({
    groups: [],
    assignments: {},
    ready: true,
    saving: false,
    error: null,
  }),
  useLibraryRows: () => h.rows,
}));
vi.mock("../runtime/agents", async (original) => ({
  ...(await original<typeof import("../runtime/agents")>()),
  useAgents: () => ({ cards: [], loading: false }),
}));
vi.mock("../runtime/theme", () => ({
  useThemePreference: () => ["system", vi.fn(), {}],
}));
vi.mock("../runtime/performance-trace", () => ({ traceAfterPaint: vi.fn() }));
import App from "../App";
import { ConversationLibrary } from "./ConversationLibrary";
import { MoveConversationsDialog } from "./MoveConversationsDialog";
import { DeleteConversationsDialog } from "./DeleteConversationsDialog";
import { collections } from "../runtime/collections";
import { threads, type IndexRow } from "../runtime/sessions";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
import { LIBRARY } from "../runtime/library_strings";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import * as transcriptCopy from "../runtime/readable_transcript";
import {
  composerDrafts,
  draftQueues,
  fileFeedbackDrafts,
} from "../runtime/drafts";

type Element = ReactElement<Record<string, unknown>>;
function renderer<P>(component: (props: P) => ReactNode, runEffects = true) {
  const slots: typeof h.slots = [];
  return (props: P) => {
    h.slots = slots;
    h.cursor = 0;
    h.runEffects = runEffects;
    let tree = component(props);
    for (const effect of h.effects.splice(0)) effect();
    h.cursor = 0;
    tree = component(props);
    const elements: Element[] = [];
    const visit = (node: ReactNode) =>
      Children.forEach(node, (child) => {
        if (!isValidElement<Record<string, unknown>>(child)) return;
        elements.push(child);
        visit(child.props.children as ReactNode);
        visit(child.props.header as ReactNode);
      });
    visit(tree);
    return elements;
  };
}
const button = (tree: Element[], text: string) =>
  tree.find(
    (e) =>
      e.type === "button" &&
      (e.props.children === text ||
        e.props["aria-label"] === text ||
        (e.props.role === "tab" &&
          Children.toArray(e.props.children as ReactNode)[0] === text)),
  )!;
const click = (element: Element) => {
  expect(element).toBeDefined();
  expect(element.props.disabled).not.toBe(true);
  const target = {
    isConnected: true,
    focus: vi.fn(),
  } as unknown as HTMLButtonElement;
  (element.props.onClick as (event: MouseEvent<HTMLButtonElement>) => void)({
    currentTarget: target,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent<HTMLButtonElement>);
  return target;
};
const messages = (tree: Element[]) =>
  tree
    .filter((e) => e.props.role === "alert")
    .map((e) =>
      Children.toArray(e.props.children as ReactNode)
        .filter((n) => typeof n === "string")
        .join(""),
    );
const description = (tree: Element[], control: Element) =>
  tree.find((element) => element.props.id === control.props["aria-describedby"])
    ?.props.children;
const row = (key: string): import("../runtime/sidebar").SidebarRow => ({
  key,
  title: key,
  agentId: "a",
  cwd: "/p",
  nativeSessionId: key,
  pinned: false,
  archived: false,
  updatedAt: 1,
  status: "idle",
  live: false,
  source: "meta",
});
const libraryProps: ComponentProps<typeof ConversationLibrary> = {
  agents: [],
  filter: { kind: "all" },
  onFilter: vi.fn(),
  onOpen: vi.fn(),
  onImport: vi.fn(),
  onNew: vi.fn(),
  defaultCwd: "/p",
};
const deletesConfirmed = () =>
  h.invoke.mockImplementation(async (command: string) =>
    command === "session_delete" ? "deleted" : [],
  );
beforeEach(() => {
  libraryProps.filter = { kind: "all" };
  libraryProps.onReopen = undefined;
  libraryProps.onFilter = vi.fn((filter) => {
    libraryProps.filter = filter;
  });
  h.effects.length = 0;
  h.rows = [row("first"), row("second"), row("third")];
  h.invoke.mockImplementation(async (command: string) =>
    command === "settings_get" ? null : [],
  );
  vi.stubGlobal("window", { location: { hash: "" } });
});
afterEach(() => {
  composerDrafts.clear("session:first");
  fileFeedbackDrafts.clear("second", "notes.txt");
  draftQueues.write("second", [], null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h.invoke.mockReset();
});

it("clears search and state filters without leaving the favorites page", () => {
  h.rows[0].pinned = true;
  libraryProps.filter = {
    kind: "selection",
    favorites: true,
    agent: "a",
    group: "",
    query: "no matching title",
    state: "unread",
  };
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.clearFilters));
  const tree = render(libraryProps);
  expect(libraryProps.filter).toMatchObject({
    favorites: true,
    agent: "",
    group: "",
    query: "",
    state: "all",
  });
  expect(tree.find((element) => element.type === "h1")?.props.children).toBe(
    LIBRARY.favorites,
  );
  expect(tree.some((element) => element.props.children === "first")).toBe(true);
  expect(tree.some((element) => element.props.children === "second")).toBe(
    false,
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command !== "settings_get"),
  ).toBe(false);
});

it("opens a group dialog for the visible selection and does not move anything on cancel", () => {
  const assign = vi.spyOn(collections, "assign").mockResolvedValue();
  libraryProps.filter = {
    kind: "selection",
    favorites: false,
    agent: "",
    group: "",
    query: "first",
    state: "all",
  };
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.organize));
  expect(button(render(libraryProps), LIBRARY.assign).props.disabled).toBe(
    true,
  );
  const all = render(libraryProps).find(
    (element) => element.props["aria-label"] === LIBRARY.selectAll,
  )!;
  (all.props.onChange as () => void)();
  click(button(render(libraryProps), LIBRARY.assign));
  const dialog = render(libraryProps).find(
    (element) => element.type === MoveConversationsDialog,
  )!;
  expect(dialog.props.count).toBe(1);
  expect(assign).not.toHaveBeenCalled();
  (dialog.props.onClose as () => void)();
  expect(
    render(libraryProps).some(
      (element) => element.type === MoveConversationsDialog,
    ),
  ).toBe(false);
  expect(assign).not.toHaveBeenCalled();
  expect(
    render(libraryProps).find(
      (element) => element.props["aria-label"] === "first",
    )?.props.checked,
  ).toBe(true);
});

it("keeps a failed group move open for retry and returns to the row action trigger", async () => {
  const assign = vi
    .spyOn(collections, "assign")
    .mockRejectedValueOnce(new Error(LIBRARY.saveError))
    .mockResolvedValueOnce();
  const render = renderer(ConversationLibrary);
  const trigger = {};
  (
    button(render(libraryProps), LIBRARY.actions("first")).props.onClick as (
      event: unknown,
    ) => void
  )({ currentTarget: trigger });
  click(button(render(libraryProps), LIBRARY.assign));
  let dialog = render(libraryProps).find(
    (element) => element.type === MoveConversationsDialog,
  )!;
  expect((dialog.props.returnFocusRef as { current: unknown }).current).toBe(
    trigger,
  );
  (dialog.props.onMove as (group: string) => void)("group-a");
  await vi.waitFor(() =>
    expect(
      render(libraryProps).find(
        (element) => element.type === MoveConversationsDialog,
      )?.props.error,
    ).toBe(LIBRARY.saveError),
  );
  expect(assign).toHaveBeenCalledExactlyOnceWith(["first"], "group-a");
  dialog = render(libraryProps).find(
    (element) => element.type === MoveConversationsDialog,
  )!;
  (dialog.props.onMove as (group: string) => void)("");
  await vi.waitFor(() =>
    expect(
      render(libraryProps).some(
        (element) => element.type === MoveConversationsDialog,
      ),
    ).toBe(false),
  );
  expect(assign).toHaveBeenLastCalledWith(["first"], "");
});

it("ignores a late group-save failure after leaving the library", async () => {
  let reject!: (reason: Error) => void;
  vi.spyOn(collections, "assign").mockImplementation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.actions("first")));
  click(button(render(libraryProps), LIBRARY.assign));
  const dialog = render(libraryProps).find(
    (element) => element.type === MoveConversationsDialog,
  )!;
  (dialog.props.onMove as (group: string) => void)("group-a");
  render({ ...libraryProps, active: false });
  reject(new Error(LIBRARY.saveError));
  await Promise.resolve();
  await Promise.resolve();
  const tree = render(libraryProps);
  expect(tree.some((element) => element.type === MoveConversationsDialog)).toBe(
    false,
  );
  expect(messages(tree)).toEqual([]);
});

it("disables archive before invocation while the conversation still has an active step", async () => {
  const state = threads.markOpenFailed(
    "a:/p:busy-menu",
    "a",
    "/p",
    "busy-menu",
    "fixture",
  );
  state.openError = null;
  state.activeToolCallIds = ["still-active"];
  const index: IndexRow = {
    id: state.key,
    agentId: "a",
    cwd: "/p",
    nativeSessionId: "busy-menu",
    title: "Busy",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  };
  h.invoke.mockImplementation(async (command: string) =>
    command === "session_index_list" ? [index] : null,
  );
  await threads.refreshIndex();
  h.invoke.mockClear();
  const shell = renderer(App, false);
  const library = shell(undefined).find((e) => e.type === ConversationLibrary)!;
  (library.props.onOpen as (row: IndexRow) => void)(index);
  const page = shell(undefined).find(
    (e) => typeof e.type === "function" && e.props.viewKey === state.key,
  )!;
  const render = renderer(
    page.type as (props: Record<string, unknown>) => ReactNode,
  );
  let header = render(page.props);
  expect(header.find((element) => element.type === "h1")?.props.title).toBe(
    "Busy",
  );
  const content = button(header, W.showContent);
  expect(content.props.title).toBe(W.showContent);
  expect(content.props["aria-expanded"]).toBe(false);
  expect(
    header.some(
      (element) =>
        element.type === "span" && element.props.children === W.content,
    ),
  ).toBe(true);
  const contentTrigger = click(content);
  header = render(page.props);
  expect(
    (
      header.find((element) => element.props.artifactReturnFocusRef)?.props
        .artifactReturnFocusRef as { current: HTMLButtonElement }
    ).current,
  ).toBe(contentTrigger);
  expect(button(header, W.hideContent).props.title).toBe(W.hideContent);
  expect(button(header, W.hideContent).props["aria-expanded"]).toBe(true);
  click(button(render(page.props), LIBRARY.actions("Busy")));
  expect(button(render(page.props), LIBRARY.archive).props.disabled).toBe(true);
  expect(
    description(
      render(page.props),
      button(render(page.props), LIBRARY.archive),
    ),
  ).toBe(LIBRARY.archiveReasons.running);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_meta_archive"),
  ).toBe(false);
  state.activeToolCallIds = [];
  composerDrafts.update(`session:${state.key}`, () => ({
    text: "",
    attachments: [{ id: "attachment", kind: "file", name: "notes.txt" }],
  }));
  expect(button(render(page.props), LIBRARY.archive).props.disabled).toBe(true);
  expect(
    description(
      render(page.props),
      button(render(page.props), LIBRARY.archive),
    ),
  ).toBe(LIBRARY.archiveReasons.unsent);
  index.archived = true;
  await threads.refreshIndex();
  expect(button(render(page.props), LIBRARY.restore).props.disabled).toBe(
    false,
  );
  expect(
    button(render(page.props), LIBRARY.restore).props["aria-describedby"],
  ).toBeUndefined();
  composerDrafts.clear(`session:${state.key}`);
  index.archived = false;
  await threads.refreshIndex();
  expect(button(render(page.props), LIBRARY.archive).props.disabled).toBe(
    false,
  );
});

it("describes an unfinished step after stop without calling newer work unknown", () => {
  const state = threads.markOpenFailed(
    "a:/p:header-tail",
    "a",
    "/p",
    "header-tail",
    "fixture",
  );
  state.openError = null;
  state.title = "Tool tail";
  state.running = true;
  const channel = threads as unknown as {
    applyChannelEvent(key: string, event: unknown): void;
  };
  channel.applyChannelEvent(state.key, {
    kind: "toolActivity",
    toolCallIds: ["sleep"],
  });
  channel.applyChannelEvent(state.key, {
    kind: "turnEnd",
    stopReason: "cancelled",
  });
  expect(state.running).toBe(false);
  expect(state.queuePaused).toBe("stopped");
  const shell = renderer(App, false);
  const library = shell(undefined).find(
    (element) => element.type === ConversationLibrary,
  )!;
  (library.props.onOpen as (value: ReturnType<typeof row>) => void)(
    row(state.key),
  );
  const page = shell(undefined).find(
    (element) =>
      typeof element.type === "function" && element.props.viewKey === state.key,
  )!;
  const render = renderer(
    page.type as (props: Record<string, unknown>) => ReactNode,
  );
  const read = (node: ReactNode): string =>
    Children.toArray(node)
      .map((child) =>
        typeof child === "string"
          ? child
          : isValidElement<{ children?: ReactNode }>(child)
            ? read(child.props.children)
            : "",
      )
      .join("");
  const headerText = () =>
    read(
      render(page.props).find(
        (element) => element.props.className === "thread-title",
      )?.props.children as ReactNode,
    );
  expect(headerText()).toContain(STRINGS.thread.unknown);
  expect(headerText()).not.toContain(LIBRARY.notRunning);
  state.running = true;
  expect(headerText()).toContain(LIBRARY.running);
  state.running = false;
  state.asyncTasks = {
    connectionId: state.connectionId ?? "current-connection",
    sessionId: state.nativeSessionId ?? "header-tail",
    supported: true,
    overflow: false,
    tasks: [
      {
        asyncTaskId: "independent-new-task",
        name: "New background task",
        taskType: "fixture",
        toolCallId: null,
        canStop: true,
        state: "running",
        stopRequest: "idle",
      },
    ],
  };
  expect(headerText()).toContain(LIBRARY.running);
  state.asyncTasks = undefined;
  expect(headerText()).toContain(STRINGS.thread.unknown);
  state.connectionOutcomeUnknown = true;
  expect(headerText()).toContain(LIBRARY.attention);
  state.connectionOutcomeUnknown = false;
  channel.applyChannelEvent(state.key, {
    kind: "toolActivity",
    toolCallIds: [],
  });
  expect(headerText()).toContain(LIBRARY.notRunning);
  expect(state.queuePaused).toBe("stopped");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("copies only the rendered conversation with its title, not unrendered store text", () => {
  const state = threads.markOpenFailed(
    "copy-visible",
    "a",
    "/p",
    "copy-visible",
    "fixture",
  );
  state.title = "Copy title";
  state.items.push({
    kind: "agent",
    id: "unrendered",
    text: "STORE-ONLY-TEXT",
    streaming: false,
    time: 1,
  });
  const shell = renderer(App, false);
  const library = shell(undefined).find((e) => e.type === ConversationLibrary)!;
  (library.props.onOpen as (row: unknown) => void)({
    id: state.key,
    agentId: "a",
    cwd: "/p",
    nativeSessionId: state.nativeSessionId,
  });
  const page = shell(undefined).find(
    (e) => typeof e.type === "function" && e.props.viewKey === state.key,
  )!;
  const render = renderer(
    page.type as (props: Record<string, unknown>) => ReactNode,
  );
  const tree = render(page.props);
  const transcript = {} as Element;
  const host = {
    querySelector: vi.fn(() => transcript),
    querySelectorAll: () => [],
  };
  (
    tree.find((node) => node.type === "main")!.props.ref as { current: unknown }
  ).current = host;
  const read = vi
    .spyOn(transcriptCopy, "readableTranscript")
    .mockReturnValue("Copy title\nVisible attachment and expanded steps");
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: write } });
  click(button(render(page.props), LIBRARY.actions("Copy title")));
  click(button(render(page.props), LIBRARY.copy));
  expect(read).toHaveBeenCalledWith(transcript, "Copy title");
  expect(write).toHaveBeenCalledWith(
    "Copy title\nVisible attachment and expanded steps",
  );
  expect(host.querySelector).toHaveBeenCalledWith(".transcript");
});

it.each([
  "attachment",
  "queue",
  "feedback",
  "queueEdit",
  "submitting",
  "configuring",
] as const)(
  "explains %s even on an idle library row and releases the entry once resolved",
  (kind) => {
    const key = `library-archive-${kind}`;
    h.rows = [row(key)];
    const state = threads.markOpenFailed(key, "a", "/p", key, "fixture");
    state.openError = null;
    let clear: () => void;
    let expected: string = LIBRARY.archiveReasons.unsent;
    if (kind === "attachment") {
      composerDrafts.update(`session:${key}`, () => ({
        text: "",
        attachments: [{ id: "one", kind: "file", name: "notes.txt" }],
      }));
      clear = () => composerDrafts.clear(`session:${key}`);
    } else if (kind === "queue") {
      draftQueues.write(key, [[{ type: "text", text: "Later" }]], null);
      clear = () => draftQueues.write(key, [], null);
    } else if (kind === "feedback") {
      fileFeedbackDrafts.update(key, "notes.txt", {
        text: "Revise",
        selection: null,
      });
      clear = () => fileFeedbackDrafts.clear(key, "notes.txt");
    } else if (kind === "queueEdit") {
      composerDrafts.update(`queue-edit:${key}`, () => ({
        text: "",
        attachments: [],
        queueEdit: { index: 0, original: [] },
      }));
      clear = () => composerDrafts.clear(`queue-edit:${key}`);
    } else {
      state[kind] = true;
      expected = LIBRARY.archiveReasons[kind];
      clear = () => {
        state[kind] = false;
      };
    }
    const render = renderer(ConversationLibrary);
    click(button(render(libraryProps), LIBRARY.actions(key)));
    let tree = render(libraryProps);
    expect(button(tree, LIBRARY.archive).props.disabled).toBe(true);
    expect(description(tree, button(tree, LIBRARY.archive))).toBe(expected);
    clear();
    tree = render(libraryProps);
    expect(button(tree, LIBRARY.archive).props.disabled).toBe(false);
    expect(
      button(tree, LIBRARY.archive).props["aria-describedby"],
    ).toBeUndefined();
  },
);

it("counts each blocked selection once and keeps restoration available", () => {
  composerDrafts.update("session:first", () => ({
    text: "Keep",
    attachments: [],
  }));
  fileFeedbackDrafts.update("second", "notes.txt", {
    text: "Revise",
    selection: null,
  });
  draftQueues.write("second", [[{ type: "text", text: "Later" }]], null);
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.organize));
  const selectAll = render(libraryProps).find(
    (element) => element.props["aria-label"] === LIBRARY.selectAll,
  )!;
  (selectAll.props.onChange as () => void)();
  let tree = render(libraryProps);
  expect(button(tree, LIBRARY.archive).props.disabled).toBe(true);
  expect(description(tree, button(tree, LIBRARY.archive))).toContain(
    LIBRARY.archiveBlockedCount(2),
  );
  composerDrafts.clear("session:first");
  tree = render(libraryProps);
  expect(description(tree, button(tree, LIBRARY.archive))).toContain(
    LIBRARY.archiveBlockedCount(1),
  );

  // Existing unsent content must not prevent restoring a saved archive.
  click(button(render(libraryProps), LIBRARY.archived));
  h.rows = h.rows.map((item) => ({ ...item, archived: true }));
  click(button(render(libraryProps), LIBRARY.actions("second")));
  tree = render(libraryProps);
  const rowRestore = tree
    .filter(
      (element) =>
        element.type === "button" && element.props.children === LIBRARY.restore,
    )
    .at(-1)!;
  expect(rowRestore.props.disabled).toBe(false);
  expect(rowRestore.props["aria-describedby"]).toBeUndefined();
  const restoreSelection = tree.find(
    (element) => element.props["aria-label"] === LIBRARY.selectAll,
  )!;
  (restoreSelection.props.onChange as () => void)();
  tree = render(libraryProps);
  expect(button(tree, LIBRARY.restore).props.disabled).toBe(false);
  fileFeedbackDrafts.clear("second", "notes.txt");
  draftQueues.write("second", [], null);
});

it("closes a library action menu when its route becomes inactive and does not reopen it on return", () => {
  const render = renderer(ConversationLibrary);
  const visibleMenu = (tree: Element[]) =>
    tree.some(
      (node) =>
        typeof node.type === "function" &&
        node.type.name === "WorkspaceActionMenu",
    );
  click(button(render(libraryProps), LIBRARY.actions("first")));
  expect(visibleMenu(render(libraryProps))).toBe(true);
  expect(visibleMenu(render({ ...libraryProps, active: false }))).toBe(false);
  expect(visibleMenu(render(libraryProps))).toBe(false);
});

it("keeps per-item batch reasons sanitized and selects only failed rows", async () => {
  vi.spyOn(threads, "setArchived").mockImplementation(async (key) => {
    if (key === "first") throw new Error(STRINGS.repair.archiveBusy);
    if (key === "third") throw "ACP transport secret-debug-value";
  });
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.organize));
  const selectAll = render(libraryProps).find(
    (e) => e.props["aria-label"] === LIBRARY.selectAll,
  )!;
  (selectAll.props.onChange as () => void)();
  click(button(render(libraryProps), LIBRARY.archive));
  await vi.waitFor(() =>
    expect(messages(render(libraryProps)).join(" ")).toContain(
      STRINGS.repair.archiveBusy,
    ),
  );
  const tree = render(libraryProps);
  expect(messages(tree).join(" ")).toContain(LIBRARY.error);
  expect(messages(tree).join(" ")).not.toContain("secret-debug-value");
  const selected = tree
    .filter(
      (e) =>
        e.type === "input" &&
        e.props.type === "checkbox" &&
        e.props.checked &&
        e.props["aria-label"] !== LIBRARY.selectAll,
    )
    .map((e) => e.props["aria-label"]);
  expect(selected).toEqual(["first", "third"]);
});

it("does not show a late batch failure or restore its old selection after a search changes", async () => {
  let reject!: (reason: unknown) => void;
  vi.spyOn(threads, "setArchived").mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.organize));
  const first = render(libraryProps).find(
    (e) => e.type === "input" && e.props["aria-label"] === "first",
  )!;
  (first.props.onChange as () => void)();
  click(button(render(libraryProps), LIBRARY.archive));
  const query = render(libraryProps).find(
    (e) => e.props["aria-label"] === LIBRARY.query,
  )!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "second" },
  });
  render(libraryProps);
  reject(new Error(STRINGS.repair.archiveBusy));
  await vi.waitFor(() =>
    expect(button(render(libraryProps), LIBRARY.favorite).props.disabled).toBe(
      false,
    ),
  );
  expect(messages(render(libraryProps))).toEqual([]);
  expect(
    render(libraryProps).filter(
      (e) =>
        e.type === "input" && e.props.type === "checkbox" && e.props.checked,
    ),
  ).toHaveLength(0);
});

it("reports the entire controlled filter when one dimension changes and clears an empty scope explicitly", () => {
  libraryProps.filter = {
    kind: "selection",
    agent: "a",
    group: "none",
    favorites: true,
    state: "all",
    query: "first",
  };
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.running));
  expect(libraryProps.onFilter).toHaveBeenLastCalledWith({
    kind: "selection",
    agent: "a",
    group: "none",
    favorites: true,
    state: "run",
    query: "first",
  });
  const query = render(libraryProps).find(
    (node) => node.props["aria-label"] === LIBRARY.query,
  )!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "no-match" },
  });
  expect(libraryProps.onFilter).toHaveBeenLastCalledWith({
    kind: "selection",
    agent: "a",
    group: "none",
    favorites: true,
    state: "run",
    query: "no-match",
  });
  click(button(render(libraryProps), LIBRARY.clearFilters));
  expect(libraryProps.onFilter).toHaveBeenLastCalledWith({
    kind: "selection",
    favorites: true,
    agent: "",
    group: "",
    query: "",
    state: "all",
  });
  expect(
    render(libraryProps).find(
      (node) => node.props["aria-label"] === LIBRARY.query,
    )?.props.value,
  ).toBe("");
});

it("deletes one conversation only after the explicit confirmation", async () => {
  deletesConfirmed();
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.actions("first")));
  click(button(render(libraryProps), LIBRARY.deleteAction));
  const dialog = render(libraryProps).find(
    (element) => element.type === DeleteConversationsDialog,
  )!;
  expect(dialog.props.title).toBe(LIBRARY.deleteTitle(1));
  expect(dialog.props.hint).toContain("「first」");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_delete"),
  ).toBe(false);
  (dialog.props.onDelete as () => void)();
  await vi.waitFor(() =>
    expect(
      h.invoke.mock.calls.filter(([command]) => command === "session_delete"),
    ).toEqual([
      ["session_delete", { agentId: "a", cwd: "/p", nativeSessionId: "first" }],
    ]),
  );
  await vi.waitFor(() =>
    expect(
      render(libraryProps).some(
        (element) => element.type === DeleteConversationsDialog,
      ),
    ).toBe(false),
  );
});

it("deletes the selected conversations in batch after confirmation", async () => {
  deletesConfirmed();
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.organize));
  const checkbox = (key: string) =>
    render(libraryProps).find(
      (element) =>
        element.type === "input" && element.props["aria-label"] === key,
    )!;
  (checkbox("first").props.onChange as () => void)();
  (checkbox("third").props.onChange as () => void)();
  click(button(render(libraryProps), LIBRARY.deleteSelected));
  const dialog = render(libraryProps).find(
    (element) => element.type === DeleteConversationsDialog,
  )!;
  expect(dialog.props.title).toBe(LIBRARY.deleteTitle(2));
  (dialog.props.onDelete as () => void)();
  await vi.waitFor(() =>
    expect(
      h.invoke.mock.calls.filter(([command]) => command === "session_delete"),
    ).toHaveLength(2),
  );
  expect(
    h.invoke.mock.calls
      .filter(([command]) => command === "session_delete")
      .map(([, args]) => (args as { nativeSessionId: string }).nativeSessionId)
      .sort(),
  ).toEqual(["first", "third"]);
});

it("clears every archived conversation with an in-place confirmation naming the scope", async () => {
  deletesConfirmed();
  h.rows = [
    row("first"),
    { ...row("second"), archived: true },
    { ...row("third"), archived: true },
  ];
  const snapshot = threads.getSnapshot();
  vi.spyOn(threads, "getSnapshot").mockImplementation(() => ({
    ...snapshot,
    index: h.rows.map((item) => ({
      ...item,
      id: item.key,
      createdAt: 1,
      configOptions: null,
    })),
  }));
  libraryProps.filter = {
    kind: "selection",
    favorites: false,
    agent: "",
    group: "",
    query: "",
    state: "archived",
  };
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.clearArchived));
  const dialog = render(libraryProps).find(
    (element) => element.type === DeleteConversationsDialog,
  )!;
  expect(dialog.props.title).toBe(LIBRARY.clearArchivedTitle);
  expect(dialog.props.hint).toBe(R.archivedScope(2));
  (dialog.props.onDelete as () => void)();
  await vi.waitFor(() =>
    expect(
      h.invoke.mock.calls
        .filter(([command]) => command === "session_delete")
        .map(
          ([, args]) => (args as { nativeSessionId: string }).nativeSessionId,
        )
        .sort(),
    ).toEqual(["second", "third"]),
  );
  // The active row is untouched.
  expect(
    h.invoke.mock.calls.some(
      ([command, args]) =>
        command === "session_delete" &&
        (args as { nativeSessionId: string }).nativeSessionId === "first",
    ),
  ).toBe(false);
});

it("reveals the conversation's working location in the file manager on request", async () => {
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.actions("first")));
  click(button(render(libraryProps), LIBRARY.revealLocation));
  await vi.waitFor(() =>
    expect(h.invoke.mock.calls).toContainEqual([
      "file_delivery_reveal_location",
      { path: "/p" },
    ]),
  );
});

it("reopens with the same settings through the shared entry", () => {
  const onReopen = vi.fn();
  libraryProps.onReopen = onReopen;
  const render = renderer(ConversationLibrary);
  click(button(render(libraryProps), LIBRARY.actions("first")));
  click(button(render(libraryProps), LIBRARY.reopenSame));
  expect(onReopen).toHaveBeenCalledTimes(1);
  expect((onReopen.mock.calls[0][0] as { key: string }).key).toBe("first");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_delete"),
  ).toBe(false);
});
