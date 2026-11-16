import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[] }[],
  cursor: 0,
  effects: [] as (() => void)[],
  choose: vi.fn(),
  discover: vi.fn(),
  preview: vi.fn(),
  closePreview: vi.fn(),
  commit: vi.fn(),
  refresh: vi.fn(),
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
  useEffect: (effect: () => void, deps: unknown[]) => {
    const i = h.cursor++;
    const slot = h.slots[i];
    if (
      !slot ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    )
      h.effects.push(effect);
    h.slots[i] = { deps };
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.choose }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/authentication", async (original) => ({
  ...(await original<typeof import("../runtime/authentication")>()),
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/history_import", () => ({
  discoverHistory: h.discover,
  previewHistory: (agentId: string, row: unknown) => h.preview(agentId, row),
  readHistoryPreview: async (agentId: string, row: unknown) => ({
    ...(await h.preview(agentId, row)),
    purpose: "searchReadOnly",
  }),
  closeHistoryPreview: h.closePreview,
  commitHistoryPreview: h.commit,
  hasPreviewContent: () => true,
  historyContinuation: () => ({
    title: "Read only",
    detail: "Verify before sending",
  }),
}));
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ index: [] }), refreshIndex: h.refresh },
}));
import { ImportConversations } from "./ImportConversations";
import { KnownHistoryImport } from "./KnownHistoryImport";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import { ERROR_STRINGS } from "../runtime/error_strings";
import type { AgentCardModel } from "../runtime/agents";
import type { DiscoveredConversation } from "../runtime/history_import";
import type { IndexRow } from "../runtime/sessions";

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
const retired: AgentCardModel = {
  ...agent,
  id: "retired",
  name: "Retired catalog Agent",
  source: "registry",
  firstBatchVisible: false,
};
const retiredHistory: IndexRow = {
  id: "existing-retired-history",
  nativeSessionId: "original-retired-history",
  agentId: retired.id,
  cwd: "/original-retired",
  title: "Already saved",
  pinned: false,
  archived: true,
  createdAt: 1,
  updatedAt: 1,
  configOptions: null,
};
let props: ComponentProps<typeof ImportConversations>;
function render() {
  h.cursor = 0;
  ImportConversations(props);
  for (const effect of h.effects.splice(0)) effect();
  h.cursor = 0;
  const tree = ImportConversations(props);
  const elements: ReactElement<Record<string, unknown>>[] = [];
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
function agentChoice(id: string) {
  return render().find((node) => node.type === "button" && node.key === id);
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
function readKnown(cwd: string) {
  const entry = render().find((node) => node.type === KnownHistoryImport);
  expect(entry).toBeDefined();
  const { reader, read, run } = entry!.props as ComponentProps<
    typeof KnownHistoryImport
  >;
  return { reader, pending: run(() => read("typed-id", cwd, () => true)) };
}
beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.choose.mockReset();
  h.discover.mockReset().mockResolvedValue({
    status: "supported",
    sessions: [row],
    nextCursor: "old-page-2",
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
    agents: [agent, { ...agent, id: "b", name: "Agent B" }],
    open: true,
    initialAgentId: "a",
    requestRevision: 1,
    onClose: vi.fn(),
    onOpen: vi.fn(),
  };
});

it.each([null, retired.id])(
  "excludes zero-history retired entries without hiding custom or discovered Agents (entry %s)",
  async (initialAgentId) => {
    props = {
      ...props,
      initialAgentId,
      agents: [
        retired,
        agent,
        { ...retired, id: "custom", custom: true, source: "custom" },
        { ...retired, id: "discovered", source: "discovered" },
      ],
    };
    expect(agentChoice(retired.id)).toBeUndefined();
    expect(agentChoice(agent.id)?.props["aria-pressed"]).toBe(true);
    expect(agentChoice("custom")).toBeDefined();
    expect(agentChoice("discovered")).toBeDefined();
    click(S.search);
    await idle();
    expect(h.discover).toHaveBeenCalledExactlyOnceWith(
      agent.id,
      undefined,
      null,
    );
  },
);

it("keeps indexed retired history available without offering a new draft", async () => {
  props = {
    ...props,
    agents: [agent, retired],
    index: [retiredHistory],
    initialAgentId: retired.id,
    onNew: vi.fn(),
  };
  h.discover.mockResolvedValueOnce({
    status: "unsupported",
    sessions: [],
    nextCursor: null,
  });
  expect(agentChoice(retired.id)?.props["aria-pressed"]).toBe(true);
  click(S.search);
  await idle();
  expect(h.discover).toHaveBeenCalledExactlyOnceWith(
    retired.id,
    undefined,
    null,
  );
  expect(button(S.newChat)).toBeUndefined();
  expect(props.onNew).not.toHaveBeenCalled();
});

it("does not publish a retired Agent's pending lookup after its last history disappears", async () => {
  props = {
    ...props,
    agents: [agent, retired],
    index: [retiredHistory],
    initialAgentId: retired.id,
  };
  let finish!: (page: unknown) => void;
  h.discover.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  click(S.search);
  await vi.waitFor(() => expect(h.discover).toHaveBeenCalledOnce());
  props = { ...props, index: [] };
  render();
  finish({ status: "supported", sessions: [row], nextCursor: null });
  await idle();
  await vi.waitFor(() =>
    expect(agentChoice(agent.id)?.props["aria-pressed"]).toBe(true),
  );
  expect(agentChoice(retired.id)).toBeUndefined();
  expect(render().some((node) => node.props["aria-label"] === row.title)).toBe(
    false,
  );
  expect(h.discover).toHaveBeenCalledExactlyOnceWith(
    retired.id,
    undefined,
    null,
  );
});

it("waits for an explicit retry when a retired selection cannot release its preview", async () => {
  props = {
    ...props,
    agents: [agent, retired],
    index: [retiredHistory],
    initialAgentId: retired.id,
  };
  click(S.search);
  await idle();
  const result = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).some(
        (child) =>
          isValidElement<{ children: ReactNode }>(child) &&
          child.props.children === row.title,
      ),
  )!;
  (result.props.onClick as () => void)();
  await idle();
  expect(h.preview).toHaveBeenCalledExactlyOnceWith(retired.id, row);

  h.closePreview.mockRejectedValueOnce(new Error("cleanup failed"));
  props = { ...props, index: [] };
  render();
  await vi.waitFor(() => {
    const nodes = render();
    expect(h.closePreview).toHaveBeenCalledOnce();
    expect(nodes.some((node) => node.props.children === S.cleanupFailed)).toBe(
      true,
    );
  });
  expect(h.discover).toHaveBeenCalledOnce();

  click(S.changeAgent);
  await idle();
  expect(h.closePreview).toHaveBeenCalledTimes(2);
  expect(agentChoice(retired.id)).toBeUndefined();
  (agentChoice(agent.id)!.props.onClick as () => void)();
  await idle();
  expect(agentChoice(agent.id)?.props["aria-pressed"]).toBe(true);
  expect(h.discover).toHaveBeenCalledOnce();
});

it("leaves the first lookup in the Agent default range and keeps pagination accessible after local filtering", async () => {
  expect(
    render().some((node) => node.props.children === S.defaultScopeHint),
  ).toBe(true);
  click(S.search);
  await idle();
  expect(h.discover).toHaveBeenCalledWith("a", undefined, null);
  const query = render().find((node) => node.props["aria-label"] === S.query)!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "not-on-this-page" },
  });
  expect(render().some((node) => node.props.children === S.noMatches)).toBe(
    true,
  );
  click(S.more);
  await idle();
  expect(h.discover).toHaveBeenLastCalledWith("a", "old-page-2", null);
});

it("does not claim to query the Agent while the folder chooser is open", async () => {
  let resolve!: (value: string | null) => void;
  h.choose.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  click(S.chooseLocation);
  expect(h.choose).toHaveBeenCalledOnce();
  expect(h.discover).not.toHaveBeenCalled();
  expect(render().some((node) => node.props.children === S.searching)).toBe(
    false,
  );
  resolve(null);
  await idle();
});

it("shows only the source and lookup state while the Agent list request is pending", async () => {
  let resolve!: (value: unknown) => void;
  h.discover.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  click(S.search);
  await vi.waitFor(() => expect(h.discover).toHaveBeenCalledOnce());
  const nodes = render();
  expect(nodes.some((node) => node.props.children === S.searching)).toBe(true);
  expect(
    nodes.some((node) => node.props.className === "history-agent-grid"),
  ).toBe(false);
  expect(
    nodes.find((node) => node.props["aria-current"] === "step")?.props.children,
  ).toContain(S.steps[1]);
  resolve({ status: "supported", sessions: [], nextCursor: null });
  await idle();
});

it("changes lookup location only on confirmation, releases the preview, and resets old results, selection, search, and cursor", async () => {
  click(S.search);
  await idle();
  const checkbox = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (checkbox.props.onChange as () => void)();
  const result = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).some(
        (child) =>
          isValidElement<{ children: ReactNode }>(child) &&
          child.props.children === row.title,
      ),
  )!;
  (result.props.onClick as () => void)();
  await idle();
  expect(h.preview).toHaveBeenCalledWith("a", row);
  h.choose.mockResolvedValueOnce(null);
  click(S.chooseLocation);
  await idle();
  expect(h.closePreview).not.toHaveBeenCalled();
  expect(button(S.more)).toBeDefined();
  h.choose.mockResolvedValueOnce("/chosen");
  click(S.chooseLocation);
  await idle();
  expect(h.closePreview).toHaveBeenCalledWith(
    expect.objectContaining({ previewToken: "preview-original" }),
  );
  expect(button(S.more)).toBeUndefined();
  expect(render().some((node) => node.props.children === row.title)).toBe(
    false,
  );
  expect(render().some((node) => node.props["aria-label"] === S.query)).toBe(
    false,
  );
  expect(h.discover).toHaveBeenCalledTimes(1);
  click(S.search);
  await idle();
  expect(h.discover).toHaveBeenLastCalledWith("a", undefined, "/chosen");
  expect(button(S.add)?.props.disabled).toBe(true);
  click(S.more);
  await idle();
  expect(h.discover).toHaveBeenLastCalledWith("a", "old-page-2", "/chosen");
  click(S.resetScope);
  await idle();
  expect(button(S.add)?.props.disabled).toBe(false);
  expect(h.discover).toHaveBeenCalledTimes(3);
});

it("does not apply a late folder choice after the window closes", async () => {
  let finish!: (cwd: string) => void;
  h.choose.mockReturnValue(
    new Promise<string>((resolve) => (finish = resolve)),
  );
  click(S.chooseLocation);
  click(S.cancel);
  props = { ...props, open: false };
  render();
  finish("/late");
  await vi.waitFor(() => expect(h.choose).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  props = { ...props, open: true };
  await idle();
  expect(button(S.resetScope)).toBeUndefined();
  expect(h.discover).not.toHaveBeenCalled();
});

it("discards a late list response when a different Agent was requested while it was loading", async () => {
  let finish!: (value: unknown) => void;
  h.discover.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  click(S.search);
  await vi.waitFor(() => expect(h.discover).toHaveBeenCalledTimes(1));
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  finish({ status: "supported", sessions: [row], nextCursor: "old-cursor" });
  await idle();
  expect(render().some((node) => node.props.children === row.title)).toBe(
    false,
  );
  expect(button(S.more)).toBeUndefined();
  click(S.search);
  await idle();
  expect(h.discover).toHaveBeenLastCalledWith("b", undefined, null);
});

it("releases a late preview before showing a newly requested Agent", async () => {
  click(S.search);
  await idle();
  let finish!: (value: unknown) => void;
  h.preview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const result = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).some(
        (child) =>
          isValidElement<{ children: ReactNode }>(child) &&
          child.props.children === row.title,
      ),
  )!;
  (result.props.onClick as () => void)();
  await vi.waitFor(() => expect(h.preview).toHaveBeenCalledTimes(1));
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  finish({
    agentId: "a",
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    previewToken: "late-preview",
    replayComplete: true,
    state: { items: [], configOptions: [] },
  });
  await idle();
  expect(h.closePreview).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ previewToken: "late-preview" }),
  );
  expect(render().some((node) => node.props.children === row.title)).toBe(
    false,
  );
  click(S.search);
  await idle();
  expect(h.discover).toHaveBeenLastCalledWith("b", undefined, null);
});

it("retains selection and query by Agent and returns to existing results without another lookup", async () => {
  click(S.search);
  await idle();
  const selected = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (selected.props.onChange as () => void)();
  const query = render().find((node) => node.props["aria-label"] === S.query)!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "Original" },
  });
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  await idle();
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [{ ...row, nativeSessionId: "b-result", title: "B result" }],
    nextCursor: null,
  });
  click(S.search);
  await idle();
  expect(button(S.add)?.props.disabled).toBe(true);
  props = { ...props, initialAgentId: "a", requestRevision: 3 };
  render();
  await idle();
  expect(
    render().find((node) => node.props["aria-label"] === S.query)?.props.value,
  ).toBe("Original");
  expect(button(S.add)?.props.disabled).toBe(false);
  expect(h.discover).toHaveBeenCalledTimes(2);
  expect(render().some((node) => node.props.children === row.title)).toBe(true);
});

it("retains chosen rows hidden by a local query and makes their count explicit before adding", async () => {
  click(S.search);
  await idle();
  const selected = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (selected.props.onChange as () => void)();
  const query = render().find((node) => node.props["aria-label"] === S.query)!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "no-match" },
  });
  expect(
    render().some(
      (node) =>
        node.props.children === `${S.selected(1)}${S.selectedHidden(1)}`,
    ),
  ).toBe(true);
  expect(button(S.add)?.props.disabled).toBe(false);
  click(S.clearQuery);
  expect(
    render().find((node) => node.props["aria-label"] === row.title)?.props
      .checked,
  ).toBe(true);
  expect(h.discover).toHaveBeenCalledTimes(1);
});

it("keeps still-eligible selections when the discovered list refreshes", async () => {
  click(S.search);
  await idle();
  const selected = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (selected.props.onChange as () => void)();
  click(S.again);
  await idle();
  expect(
    render().find((node) => node.props["aria-label"] === row.title)?.props
      .checked,
  ).toBe(true);
  expect(button(S.add)?.props.disabled).toBe(false);
});

it("removes only disappeared or newly ineligible selections during refresh and keeps them on lookup failure", async () => {
  const gone = { ...row, nativeSessionId: "gone", title: "Gone" };
  const blocked = { ...row, nativeSessionId: "blocked", title: "Blocked" };
  const added = { ...row, nativeSessionId: "added", title: "Added" };
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [row, gone, blocked, added],
    nextCursor: null,
  });
  click(S.search);
  await idle();
  const all = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (all.props.onChange as () => void)();
  h.discover.mockRejectedValueOnce(new Error("lookup failed"));
  click(S.again);
  await idle();
  expect(
    render().find((node) => node.props["aria-label"] === row.title)?.props
      .checked,
  ).toBe(true);
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [
      row,
      { ...blocked, canLoad: false },
      { ...added, alreadyAddedId: "already-saved" },
      { ...row, nativeSessionId: "new", title: "New" },
    ],
    nextCursor: null,
  });
  click(S.again);
  await idle();
  const selectedRows = render().filter(
    (node) =>
      node.type === "input" &&
      node.props.type === "checkbox" &&
      node.props["aria-label"] &&
      node.props.checked,
  );
  expect(selectedRows.map((node) => node.props["aria-label"])).toEqual([
    row.title,
  ]);
});

it("clears the entire selection even when every chosen result is hidden by search", async () => {
  click(S.search);
  await idle();
  const all = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (all.props.onChange as () => void)();
  const query = render().find((node) => node.props["aria-label"] === S.query)!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "no match" },
  });
  click(S.clearSelection);
  expect(button(S.add)?.props.disabled).toBe(true);
  click(S.clearQuery);
  expect(
    render().find((node) => node.props["aria-label"] === row.title)?.props
      .checked,
  ).toBe(false);
  expect(h.commit).not.toHaveBeenCalled();
});

it("offers a new draft for the selected Agent when listing is unsupported", async () => {
  props.onNew = vi.fn();
  h.discover.mockResolvedValueOnce({
    status: "unsupported",
    sessions: [],
    nextCursor: null,
  });
  click(S.search);
  await idle();
  click(S.newChat);
  await idle();
  expect(props.onNew).toHaveBeenCalledExactlyOnceWith("a");
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
});

it("does not open a new draft if its import context changes during handoff", async () => {
  props.onNew = vi.fn();
  h.discover.mockResolvedValueOnce({
    status: "unsupported",
    sessions: [],
    nextCursor: null,
  });
  click(S.search);
  await idle();
  click(S.newChat);
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  await idle();
  expect(props.onNew).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("retries one failed row without resubmitting successful or other selected rows", async () => {
  const other = { ...row, nativeSessionId: "other", title: "Other" };
  const third = { ...row, nativeSessionId: "third", title: "Third" };
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [row, other, third],
    nextCursor: null,
  });
  const save = h.commit.getMockImplementation()!;
  const attempted = new Set<string>();
  h.commit.mockImplementation(async (preview, title) => {
    if (
      preview.nativeSessionId !== "other" &&
      !attempted.has(preview.nativeSessionId)
    ) {
      attempted.add(preview.nativeSessionId);
      throw new Error("write failed");
    }
    return save(preview, title);
  });
  h.refresh.mockRejectedValueOnce(new Error("private refresh details"));
  click(S.search);
  await idle();
  const all = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (all.props.onChange as () => void)();
  click(S.add);
  await idle();
  expect(render().some((node) => node.props.children === S.refreshFailed)).toBe(
    true,
  );
  expect(
    render().filter(
      (node) => node.type === "button" && node.props.children === S.retryRow,
    ),
  ).toHaveLength(2);
  expect(button(S.retrySelected)?.props.disabled).toBe(false);
  // The captured handler may be invoked twice before a render; only one may run.
  const retry = button(S.retryRow)!;
  (retry.props.onClick as () => void)();
  (retry.props.onClick as () => void)();
  await idle();
  expect(
    h.commit.mock.calls.map(([preview]) => preview.nativeSessionId),
  ).toEqual(["original", "other", "third", "original"]);
  expect(
    render().find((node) => node.props["aria-label"] === other.title)?.props
      .disabled,
  ).toBe(true);
  expect(
    render().find((node) => node.props["aria-label"] === third.title)?.props
      .checked,
  ).toBe(true);
  expect(
    render().filter(
      (node) => node.type === "button" && node.props.children === S.retryRow,
    ),
  ).toHaveLength(1);
  click(S.retrySelected);
  await idle();
  expect(
    h.commit.mock.calls.map(([preview]) => preview.nativeSessionId),
  ).toEqual(["original", "other", "third", "original", "third"]);
  expect(button(S.retryRow)).toBeUndefined();
  expect(button(S.add)?.props.disabled).toBe(true);
});

it("keeps late partial batch results with their original Agent when another is requested", async () => {
  const failed = { ...row, nativeSessionId: "failed", title: "Failed" };
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [row, failed],
    nextCursor: null,
  });
  const save = h.commit.getMockImplementation()!;
  let reject!: (reason: unknown) => void;
  h.commit.mockImplementation((preview, title) =>
    preview.nativeSessionId === "failed"
      ? new Promise((_yes, no) => {
          reject = no;
        })
      : save(preview, title),
  );
  click(S.search);
  await idle();
  const all = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (all.props.onChange as () => void)();
  click(S.add);
  await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(2));
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  reject(new Error("write failed"));
  await idle();
  expect(button(S.retryRow)).toBeUndefined();
  expect(render().some((node) => node.props.children === row.title)).toBe(
    false,
  );
  props = { ...props, initialAgentId: "a", requestRevision: 3 };
  render();
  await idle();
  expect(button(S.retryRow)).toBeDefined();
  expect(
    render().find((node) => node.props["aria-label"] === row.title)?.props
      .disabled,
  ).toBe(true);
  expect(
    render().find((node) => node.props["aria-label"] === failed.title)?.props
      .checked,
  ).toBe(true);
  expect(h.commit).toHaveBeenCalledTimes(2);
});

it("opens preparation for a disconnected Agent and returns to the same location, query and selection without another lookup", async () => {
  props.onPrepare = vi.fn();
  h.choose.mockResolvedValueOnce("/history-folder");
  click(S.chooseLocation);
  await idle();
  click(S.search);
  await idle();
  const checkbox = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (checkbox.props.onChange as () => void)();
  const query = render().find((node) => node.props["aria-label"] === S.query)!;
  (query.props.onChange as (event: unknown) => void)({
    target: { value: "Original" },
  });
  props = { ...props, agents: [{ ...agent, status: "installed" }] };
  click(S.prepareAgent);
  await idle();
  expect(props.onPrepare).toHaveBeenCalledExactlyOnceWith(
    "a",
    "/history-folder",
  );
  props = { ...props, open: false };
  render();
  props = { ...props, open: true, agents: [agent] };
  await idle();
  expect(
    render().find((node) => node.props["aria-label"] === S.query)?.props.value,
  ).toBe("Original");
  expect(button(S.add)?.props.disabled).toBe(false);
  expect(button(S.resetScope)).toBeDefined();
  expect(h.discover).toHaveBeenCalledTimes(1);
});

it("offers preparation for explicit authentication failure but does not infer it from an unknown error", async () => {
  props.onPrepare = vi.fn();
  h.discover.mockRejectedValueOnce("AUTH_REQUIRED");
  click(S.search);
  await idle();
  expect(button(S.prepareAgent)).toBeDefined();
  h.discover.mockRejectedValueOnce("Unknown transport failure");
  click(S.search);
  await idle();
  expect(button(S.prepareAgent)).toBeUndefined();
  expect(props.onPrepare).not.toHaveBeenCalled();
});

it.each([
  ["AGENT_INITIALIZE_TIMEOUT", ERROR_STRINGS.agentInitializeTimeout],
  ["AGENT_INITIALIZE_TIMEOUT: diagnostic canary", S.listFailed],
])("uses a safe lookup explanation for %s", async (failure, explanation) => {
  props.onPrepare = vi.fn();
  h.discover.mockRejectedValueOnce(failure);
  click(S.search);
  await idle();
  const text = render().map((node) => node.props.children);
  expect(text).toContain(explanation);
  expect(text).not.toContain(failure);
  expect(button(S.prepareAgent)).toBeUndefined();
  expect(h.discover).toHaveBeenCalledOnce();
});

it("prepares the exact typed history folder when list succeeded but reading requires authentication", async () => {
  props.onPrepare = vi.fn();
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [],
    nextCursor: null,
    canLoad: true,
  });
  h.preview.mockRejectedValueOnce("AUTH_REQUIRED");
  click(S.search);
  await idle();
  const { reader, pending } = readKnown("/typed-history");
  await pending;
  expect(reader.state.error).toBe(S.authRequired);
  expect(h.commit).not.toHaveBeenCalled();
  click(S.prepareAgent);
  await idle();
  expect(props.onPrepare).toHaveBeenCalledExactlyOnceWith(
    "a",
    "/typed-history",
  );
  expect(h.preview).toHaveBeenCalledOnce();
});

it.each(["unknown", "retired"])(
  "does not prepare a typed history lookup with a %s failure",
  async (kind) => {
    props.onPrepare = vi.fn();
    h.discover.mockResolvedValueOnce({
      status: "supported",
      sessions: [],
      nextCursor: null,
      canLoad: true,
    });
    click(S.search);
    await idle();
    let reject!: (reason: string) => void;
    h.preview.mockImplementationOnce(
      () => new Promise((_resolve, fail) => (reject = fail)),
    );
    const { pending } = readKnown("/typed-history");
    await vi.waitFor(() => expect(h.preview).toHaveBeenCalledOnce());
    if (kind === "retired") {
      props = { ...props, initialAgentId: "b", requestRevision: 2 };
      render();
    }
    reject(
      kind === "retired" ? "AUTH_REQUIRED" : "Unknown AUTH_REQUIRED reply",
    );
    await pending;
    expect(button(S.prepareAgent)).toBeUndefined();
    expect(props.onPrepare).not.toHaveBeenCalled();
  },
);

it("provides a way to add an Agent when none is available without attempting history lookup", async () => {
  props = { ...props, agents: [], initialAgentId: null, onPrepare: vi.fn() };
  click(S.addAgent);
  await idle();
  expect(props.onPrepare).toHaveBeenCalledExactlyOnceWith(undefined, null);
  expect(h.discover).not.toHaveBeenCalled();
});

it("does not leave the lookup if releasing its preview fails", async () => {
  props.onPrepare = vi.fn();
  click(S.search);
  await idle();
  const result = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).some(
        (child) =>
          isValidElement<{ children: ReactNode }>(child) &&
          child.props.children === row.title,
      ),
  )!;
  (result.props.onClick as () => void)();
  await idle();
  props = { ...props, agents: [{ ...agent, status: "installed" }] };
  h.closePreview.mockRejectedValueOnce(new Error("cleanup failed"));
  click(S.prepareAgent);
  await idle();
  expect(props.onPrepare).not.toHaveBeenCalled();
  expect(render().some((node) => node.props.children === S.cleanupFailed)).toBe(
    true,
  );
});

it("ignores a preparation handoff whose lookup changed during preview release", async () => {
  props.onPrepare = vi.fn();
  click(S.search);
  await idle();
  const result = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).some(
        (child) =>
          isValidElement<{ children: ReactNode }>(child) &&
          child.props.children === row.title,
      ),
  )!;
  (result.props.onClick as () => void)();
  await idle();
  props = {
    ...props,
    agents: [
      { ...agent, status: "installed" },
      { ...agent, id: "b" },
    ],
  };
  let finish!: () => void;
  h.closePreview.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  click(S.prepareAgent);
  render();
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  finish();
  await idle();
  expect(props.onPrepare).not.toHaveBeenCalled();
  expect(h.discover).toHaveBeenCalledTimes(1);
});

it("filters Agent names without changing the selected Agent or starting a lookup", async () => {
  const search = () =>
    render().find((node) => node.props["aria-label"] === R.searchAgents)!;
  (search().props.onChange as (event: unknown) => void)({
    target: { value: "Agent B" },
  });
  expect(
    render().some(
      (node) => node.type === "strong" && node.props.children === "Agent A",
    ),
  ).toBe(false);
  expect(
    render().some(
      (node) => node.type === "strong" && node.props.children === "Agent B",
    ),
  ).toBe(true);
  expect(h.discover).not.toHaveBeenCalled();
  (search().props.onChange as (event: unknown) => void)({
    target: { value: "no-such-agent" },
  });
  expect(render().some((node) => node.props.children === R.noAgents)).toBe(
    true,
  );
  click(R.clearSearch);
  click(S.search);
  await idle();
  expect(h.discover).toHaveBeenCalledWith("a", undefined, null);
});

it("rechecks the selected original history without saving it or promoting read-only conditions", async () => {
  click(S.search);
  await idle();
  const result = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).some(
        (child) =>
          isValidElement<{ children: ReactNode }>(child) &&
          child.props.children === row.title,
      ),
  )!;
  (result.props.onClick as () => void)();
  await idle();
  click(R.previewRecheck);
  await idle();
  expect(h.preview).toHaveBeenCalledTimes(2);
  expect(h.preview).toHaveBeenLastCalledWith("a", row);
  expect(h.closePreview).toHaveBeenCalledWith(
    expect.objectContaining({ nativeSessionId: "original" }),
  );
  expect(render().some((node) => node.props.children === "Read only")).toBe(
    true,
  );
  expect(h.commit).not.toHaveBeenCalled();
  expect(props.onOpen).not.toHaveBeenCalled();
});

it("retains a late confirmed first commit for its original lookup without continuing the retired batch", async () => {
  const next = { ...row, nativeSessionId: "next", title: "Next" };
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [row, next],
    nextCursor: null,
  });
  const save = h.commit.getMockImplementation()!;
  let finish!: () => void;
  h.commit.mockImplementationOnce(
    (preview, title) =>
      new Promise((resolve) => {
        finish = () => resolve(save(preview, title));
      }),
  );
  click(S.search);
  await idle();
  const all = render().find(
    (node) => node.type === "input" && node.props.type === "checkbox",
  )!;
  (all.props.onChange as () => void)();
  click(S.add);
  await vi.waitFor(() => expect(h.commit).toHaveBeenCalledTimes(1));
  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  finish();
  await idle();
  expect(render().some((node) => node.props.children === row.title)).toBe(
    false,
  );
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledTimes(1);
  props = { ...props, initialAgentId: "a", requestRevision: 3 };
  render();
  await idle();
  expect(
    render().find((node) => node.props["aria-label"] === row.title)?.props
      .disabled,
  ).toBe(true);
  expect(
    render().find((node) => node.props["aria-label"] === next.title)?.props
      .checked,
  ).toBe(true);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledTimes(1);
});
