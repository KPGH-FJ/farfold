import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  choose: vi.fn(),
  discover: vi.fn(),
  preview: vi.fn(),
  readPreview: vi.fn(),
  closePreview: vi.fn(),
  commit: vi.fn(),
  refresh: vi.fn(),
  index: [] as import("../runtime/sessions").IndexRow[],
  indexListeners: new Set<() => void>(),
  authenticationListeners: new Set<(agentId: string) => void>(),
  credentialListeners: new Set<() => void>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    const slot = (h.slots[i] ??= {
      value:
        typeof initial === "function" ? (initial as () => unknown)() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (v: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    return (h.slots[i] ??= { value: { current: initial } }).value;
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = h.cursor++;
    const slot = h.slots[i];
    if (
      !slot ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    )
      h.effects.push(() => {
        slot?.cleanup?.();
        const cleanup = effect();
        if (typeof cleanup === "function") h.slots[i].cleanup = cleanup;
      });
    h.slots[i] = { deps, cleanup: slot?.cleanup };
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.choose }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  subscribeCredentialChanges: (listener: () => void) => {
    h.credentialListeners.add(listener);
    return () => h.credentialListeners.delete(listener);
  },
}));
vi.mock("../runtime/authentication", async (original) => ({
  ...(await original<typeof import("../runtime/authentication")>()),
  subscribeAuthenticationChanges: (listener: (agentId: string) => void) => {
    h.authenticationListeners.add(listener);
    return () => h.authenticationListeners.delete(listener);
  },
}));
vi.mock("../runtime/history_import", () => ({
  discoverHistory: h.discover,
  previewHistory: h.preview,
  readHistoryPreview: h.readPreview,
  closeHistoryPreview: h.closePreview,
  commitHistoryPreview: h.commit,
  hasPreviewContent: () => true,
  historyContinuation: () => ({
    title: "Read only",
    detail: "Verify before sending",
  }),
}));
vi.mock("../runtime/sessions", () => ({
  threads: {
    getSnapshot: () => ({ index: h.index }),
    refreshIndex: h.refresh,
    subscribe: (listener: () => void) => {
      h.indexListeners.add(listener);
      return () => h.indexListeners.delete(listener);
    },
  },
}));
import { ImportConversations } from "./ImportConversations";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import type { AgentCardModel } from "../runtime/agents";
import type {
  DiscoveredConversation,
  HistoryPreview,
} from "../runtime/history_import";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";

const agent: AgentCardModel = {
  id: "a",
  name: "Agent A",
  description: "",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: false,
  registerable: false,
  custom: false,
  handshake: null,
};
const row: DiscoveredConversation = {
  nativeSessionId: "original",
  cwd: "/original",
  title: "Original result",
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
let props: ComponentProps<typeof ImportConversations>;
type Element = ReactElement<Record<string, unknown>>;
function render() {
  h.cursor = 0;
  ImportConversations(props);
  for (const effect of h.effects.splice(0)) effect();
  h.cursor = 0;
  const tree = ImportConversations(props);
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
function button(label: string) {
  return render().find(
    (node) => node.type === "button" && node.props.children === label,
  );
}
function click(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  expect(node!.props.disabled).not.toBe(true);
  (node!.props.onClick as () => void)();
}
async function idle() {
  await vi.waitFor(() =>
    expect(button(S.chooseLocation)?.props.disabled).toBe(false),
  );
}
function outcomes() {
  return render().filter((node) =>
    String(node.props.className ?? "")
      .split(" ")
      .includes("history-outcome"),
  );
}
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : isValidElement<{ children: ReactNode }>(child)
          ? text(child.props.children)
          : "",
    )
    .join("");
}
function selectOriginal() {
  const row = render().find(
    (node) =>
      node.type === "div" &&
      String(node.props.className ?? "")
        .split(" ")
        .includes("history-row"),
  );
  expect(row).toBeDefined();
  const action = Children.toArray(row!.props.children as ReactNode).find(
    (node) => isValidElement(node) && node.type === "button",
  ) as Element;
  expect(action.props.disabled).not.toBe(true);
  (action.props.onClick as () => void)();
}
function selectForAdd() {
  const checkbox = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  );
  expect(checkbox).toBeDefined();
  (checkbox!.props.onChange as () => void)();
}
function readReceipt(token = "read-original"): HistoryPreview {
  const state = freshThreadState(
    "preview",
    agent.id,
    row.cwd,
    row.nativeSessionId,
  );
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Controlled readable original body" },
  });
  for (const item of state.items)
    if (item.kind === "agent") item.streaming = false;
  return {
    purpose: "searchReadOnly",
    agentId: agent.id,
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    previewToken: token,
    replayComplete: true,
    state,
  };
}
function indexRow(): import("../runtime/sessions").IndexRow {
  return {
    id: "related-index-row",
    agentId: agent.id,
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    title: "Retained title",
    configOptions: { model: "selected", mode: "unchanged" },
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };
}
function replaceIndex(index: typeof h.index) {
  h.index = index;
  for (const listener of h.indexListeners) listener();
  render();
}
function showsBody() {
  return render().some(
    (node) => node.props.text === "Controlled readable original body",
  );
}
async function beginPendingRead() {
  let finish!: (preview: HistoryPreview) => void;
  h.readPreview.mockReturnValueOnce(
    new Promise<HistoryPreview>((resolve) => {
      finish = resolve;
    }),
  );
  click(S.search);
  await idle();
  selectOriginal();
  await vi.waitFor(() => expect(h.readPreview).toHaveBeenCalledTimes(1));
  return finish;
}
async function displayedReadPreview() {
  click(S.search);
  await idle();
  selectOriginal();
  await idle();
  const delivered = h.readPreview.mock.results[0] ?? h.preview.mock.results[0];
  expect(delivered).toBeDefined();
  const displayed = await delivered.value;
  const state = freshThreadState(
    "preview",
    agent.id,
    row.cwd,
    row.nativeSessionId,
  );
  applyUpdate(state, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Controlled readable original body" },
  });
  for (const item of state.items)
    if (item.kind === "agent") item.streaming = false;
  const read: HistoryPreview = {
    purpose: "searchReadOnly",
    agentId: agent.id,
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    previewToken: "read-original",
    replayComplete: true,
    state,
  };
  // Arrange an already displayed, complete read receipt independently of the
  // View-route oracle. Both the existing state and its cleanup ref own it.
  let replaced = 0;
  for (const slot of h.slots) {
    if (slot.value === displayed) {
      slot.value = read;
      replaced++;
    } else if (
      slot.value &&
      typeof slot.value === "object" &&
      "current" in slot.value &&
      slot.value.current === displayed
    ) {
      slot.value.current = read;
      replaced++;
    }
  }
  expect(replaced).toBe(2);
  expect(
    render().some(
      (node) => node.props.text === "Controlled readable original body",
    ),
  ).toBe(true);
  h.readPreview.mockClear();
  h.preview.mockClear();
  h.closePreview.mockClear();
  h.commit.mockClear();
}
beforeEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots.length = 0;
  h.effects.length = 0;
  h.index = [];
  h.indexListeners.clear();
  h.authenticationListeners.clear();
  h.credentialListeners.clear();
  h.choose.mockReset();
  h.discover.mockReset().mockResolvedValue({
    status: "supported",
    sessions: [row],
    nextCursor: null,
  });
  h.preview.mockReset().mockImplementation(async (agentId, record) => ({
    agentId,
    cwd: record.cwd,
    nativeSessionId: record.nativeSessionId,
    purpose: "importPreview",
    previewToken: `preview-${record.nativeSessionId}`,
    replayComplete: true,
    state: { items: [], configOptions: [] },
  }));
  h.readPreview.mockReset().mockImplementation(async () => readReceipt());
  h.closePreview.mockReset().mockResolvedValue(undefined);
  h.commit.mockReset().mockImplementation(async (preview, title) => ({
    id: `saved-${preview.nativeSessionId}`,
    agentId: preview.agentId,
    cwd: preview.cwd,
    nativeSessionId: preview.nativeSessionId,
    title,
    archived: false,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  }));
  h.refresh.mockReset().mockResolvedValue(undefined);
  props = {
    agents: [agent],
    open: true,
    initialAgentId: "a",
    requestRevision: 1,
    onClose: vi.fn(),
    onOpen: vi.fn(),
  };
});

it("uses a read-only preview for an explicit view without creating an import", async () => {
  click(S.search);
  await idle();
  selectOriginal();
  await idle();
  expect(h.readPreview).toHaveBeenCalledTimes(1);
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});

it("closes a viewed read receipt before loading a separate import receipt for Add", async () => {
  await displayedReadPreview();
  selectForAdd();
  click(S.add);
  await idle();
  expect(h.preview).toHaveBeenCalledTimes(1);
  expect(h.closePreview).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      purpose: "searchReadOnly",
      previewToken: "read-original",
    }),
  );
  expect(h.closePreview.mock.invocationCallOrder[0]).toBeLessThan(
    h.preview.mock.invocationCallOrder[0],
  );
  expect(h.commit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      purpose: "importPreview",
      previewToken: "preview-original",
    }),
    row.title,
  );
});

it("does not open or commit an import when the viewed receipt close remains unknown", async () => {
  await displayedReadPreview();
  h.closePreview.mockRejectedValue(new Error("exact preview cleanup unknown"));
  selectForAdd();
  click(S.add);
  await idle();
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.closePreview).toHaveBeenCalledWith(
    expect.objectContaining({ purpose: "searchReadOnly" }),
  );
  expect(outcomes().some((node) => node.props.role === "alert")).toBe(true);
});

it("keeps the same preview for equivalent index facts and unrelated or title/clock changes", async () => {
  const related = indexRow();
  h.index = [related];
  click(S.search);
  await idle();
  selectOriginal();
  await idle();
  expect(showsBody()).toBe(true);
  replaceIndex([
    {
      ...related,
      title: "Renamed only",
      updatedAt: 42,
      configOptions: { mode: "unchanged", model: "selected" },
    },
    {
      ...related,
      id: "other",
      agentId: "b",
      nativeSessionId: "unrelated",
      cwd: "/other",
      title: "Other work",
    },
  ]);
  expect(showsBody()).toBe(true);
  props = {
    ...props,
    agents: [{ ...agent, version: "reported-metadata-only" }],
  };
  render();
  expect(showsBody()).toBe(true);
  expect(h.closePreview).not.toHaveBeenCalled();
  expect(h.readPreview).toHaveBeenCalledTimes(1);
  expect(h.preview).not.toHaveBeenCalled();
});

it("retires related index association ABA before a pending read can publish", async () => {
  const finish = await beginPendingRead();
  replaceIndex([indexRow()]);
  replaceIndex([]);
  finish(readReceipt("late-index-aba"));
  await idle();
  expect(showsBody()).toBe(false);
  expect(h.closePreview).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      previewToken: "late-index-aba",
      purpose: "searchReadOnly",
    }),
  );
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});

it.each(["source", "query", "request"])(
  "does not revive a pending read after %s changes back to the original value",
  async (change) => {
    const finish = await beginPendingRead();
    if (change === "source") {
      props = {
        ...props,
        agents: [{ ...agent, programPath: "/different-selected-program" }],
      };
      render();
      props = { ...props, agents: [agent] };
      render();
    } else if (change === "query") {
      const query = render().find(
        (node) => node.props["aria-label"] === S.query,
      )!;
      (query.props.onChange as (event: unknown) => void)({
        target: { value: "other" },
      });
      render();
      const changed = render().find(
        (node) => node.props["aria-label"] === S.query,
      )!;
      (changed.props.onChange as (event: unknown) => void)({
        target: { value: "" },
      });
      render();
    } else {
      props = { ...props, requestRevision: 2 };
      render();
      props = { ...props, requestRevision: 1 };
      render();
    }
    finish(readReceipt(`late-${change}-aba`));
    await idle();
    expect(showsBody()).toBe(false);
    expect(h.closePreview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ previewToken: `late-${change}-aba` }),
    );
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  },
);

it.each(["account", "credential"])(
  "invalidates the affected %s owner without reacting to an unrelated account",
  async (change) => {
    click(S.search);
    await idle();
    selectOriginal();
    await idle();
    expect(showsBody()).toBe(true);
    for (const listener of h.authenticationListeners) listener("other-agent");
    expect(showsBody()).toBe(true);
    if (change === "account") {
      for (const listener of h.authenticationListeners) listener(agent.id);
    } else {
      for (const listener of h.credentialListeners) listener();
    }
    expect(showsBody()).toBe(false);
    expect(h.readPreview).toHaveBeenCalledTimes(1);
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  },
);

it("does not load an import after related index ABA while exact read close is pending", async () => {
  click(S.search);
  await idle();
  selectOriginal();
  await idle();
  let closed!: () => void;
  h.closePreview.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      closed = resolve;
    }),
  );
  selectForAdd();
  click(S.add);
  await vi.waitFor(() => expect(h.closePreview).toHaveBeenCalledTimes(1));
  replaceIndex([indexRow()]);
  replaceIndex([]);
  closed();
  await idle();
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});

it("closes only the late exact read token after the component unmounts", async () => {
  const finish = await beginPendingRead();
  for (const slot of h.slots) slot.cleanup?.();
  const late = readReceipt("late-after-unmount");
  finish(late);
  await vi.waitFor(() => expect(h.closePreview).toHaveBeenCalledTimes(1));
  expect(h.closePreview).toHaveBeenCalledExactlyOnceWith(late);
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});

it("shows the joined result as the only outcome after a clean add", async () => {
  click(S.search);
  await idle();
  (
    render().find(
      (node) => node.type === "input" && node.props.type === "checkbox",
    )!.props.onChange as () => void
  )();
  click(S.add);
  await idle();
  const blocks = outcomes();
  expect(blocks).toHaveLength(1);
  expect(blocks[0].props.role).toBe("status");
  expect(text(blocks[0].props.children as ReactNode)).toContain(
    S.addedCount(1),
  );
  expect(text(blocks[0].props.children as ReactNode)).toContain(S.joinedHint);
  // No technical-details disclosure is part of a clean success.
  expect(
    render().some((node) => node.props.children === S.outcomeDetails),
  ).toBe(false);
  expect(render().some((node) => node.props.children === S.empty)).toBe(false);
});

it("shows one incomplete outcome with technical detail collapsed behind a disclosure", async () => {
  h.commit.mockRejectedValueOnce(new Error("private commit details"));
  click(S.search);
  await idle();
  (
    render().find(
      (node) => node.type === "input" && node.props.type === "checkbox",
    )!.props.onChange as () => void
  )();
  click(S.add);
  await idle();
  const blocks = outcomes();
  expect(blocks).toHaveLength(1);
  expect(blocks[0].props.role).toBe("alert");
  const alertText = text(blocks[0].props.children as ReactNode);
  expect(alertText).toContain(S.operationIncomplete);
  expect(alertText).toContain(S.partialHint);
  // The technical reason stays inside the collapsed details, not the headline.
  const details = render().find(
    (node) =>
      node.type === "details" &&
      node.props.className === "history-outcome-details",
  )!;
  expect(details).toBeDefined();
  expect(details.props.open).not.toBe(true);
  expect(text(details.props.children as ReactNode)).toContain(S.addFailed);
  expect(text(details.props.children as ReactNode)).toContain(row.title);
  // The headline itself carries no backend message.
  const headline = blocks[0].props.children as ReactNode;
  expect(text(headline).startsWith(S.addFailed)).toBe(false);
});

it("shows the empty/unsupported state as the third outcome without an alert or success block", async () => {
  h.discover.mockResolvedValueOnce({
    status: "unsupported",
    sessions: [],
    nextCursor: null,
  });
  click(S.search);
  await idle();
  expect(outcomes()).toHaveLength(0);
  const nodes = render();
  expect(nodes.some((node) => node.props.children === S.unsupportedTitle)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === S.unsupported)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === S.empty)).toBe(false);

  // A plain empty list stays distinct from an unsupported Agent.
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [],
    nextCursor: null,
  });
  click(S.again);
  await idle();
  const cleared = render();
  expect(cleared.some((node) => node.props.children === S.empty)).toBe(true);
  expect(
    cleared.some((node) => node.props.children === S.unsupportedTitle),
  ).toBe(false);
  expect(outcomes()).toHaveLength(0);
});
