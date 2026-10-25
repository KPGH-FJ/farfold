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
  index: [] as import("../runtime/sessions").IndexRow[],
  choose: vi.fn(),
  discover: vi.fn(),
  preview: vi.fn(),
  closePreview: vi.fn(),
  commit: vi.fn(),
  refresh: vi.fn(),
  prompt: vi.fn(),
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
            ? (next as (value: unknown) => unknown)(slot.value)
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
vi.mock("../runtime/history_import", () => ({
  discoverHistory: h.discover,
  previewHistory: h.preview,
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
    prompt: h.prompt,
  },
}));

import { ImportConversations } from "./ImportConversations";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
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
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof ImportConversations>;

function saved(id: string, title: string, cwd: string): IndexRow {
  return {
    id,
    agentId: agent.id,
    cwd,
    nativeSessionId: `native-${id}`,
    title,
    archived: false,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  };
}
function official(
  nativeSessionId: string,
  title: string,
  cwd: string,
  alreadyAddedId: string | null = null,
): DiscoveredConversation {
  return {
    nativeSessionId,
    cwd,
    title,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId,
    isOpen: false,
  };
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  let result = "";
  Children.forEach(node, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child))
      result += text(child.props.children);
    else if (typeof child === "string" || typeof child === "number")
      result += String(child);
  });
  return result;
}
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
    (node) =>
      node.type === "button" &&
      text(node.props.children as ReactNode) === label,
  );
}
function click(node: Element | undefined) {
  expect(node).toBeDefined();
  expect(node!.props.disabled).not.toBe(true);
  (node!.props.onClick as () => void)();
}
function results() {
  return render().filter((node) =>
    String(node.props.className ?? "")
      .split(" ")
      .includes("history-row"),
  );
}
function setQuery(value: string) {
  const query = render().find((node) => node.props["aria-label"] === S.query);
  expect(query).toBeDefined();
  (query!.props.onChange as (event: unknown) => void)({ target: { value } });
}
async function idle() {
  await vi.waitFor(() =>
    expect(button(S.chooseLocation)?.props.disabled).toBe(false),
  );
}
async function lookup(rows: DiscoveredConversation[]) {
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: rows,
    nextCursor: null,
  });
  click(button(S.search));
  await idle();
  expect(h.discover).toHaveBeenCalledExactlyOnceWith("a", undefined, null);
}
function expectMetadataOnly() {
  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.choose).not.toHaveBeenCalled();
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(props.onPrepare).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.index.length = 0;
  h.choose.mockReset();
  h.discover.mockReset();
  h.preview.mockReset().mockImplementation(async (agentId, row) => ({
    agentId,
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    previewToken: `preview-${row.nativeSessionId}`,
    replayComplete: true,
    state: { items: [], configOptions: [] },
  }));
  h.closePreview.mockReset().mockResolvedValue(undefined);
  h.commit.mockReset();
  h.refresh.mockReset().mockResolvedValue(undefined);
  h.prompt.mockReset();
  props = {
    agents: [agent, { ...agent, id: "b", name: "Agent B" }],
    open: true,
    initialAgentId: "a",
    requestRevision: 1,
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onPrepare: vi.fn(),
  };
});

it("keeps the official title and shows the exact joined conversation's retained title and saved location", async () => {
  const local = saved(
    "internal-original-id",
    "My retained first reply",
    "/owned/saved-original",
  );
  h.index.push(local);
  const row = official(
    local.nativeSessionId!,
    "Official title changed",
    "/reported/current",
    local.id,
  );
  await lookup([row]);
  expectMetadataOnly();
  const displayed = text(results()[0]);
  expect(displayed).toContain(row.title);
  expect(displayed).toContain(local.title);
  expect(displayed).toContain(local.cwd);
  expect(displayed).not.toContain(local.id);
  expect(displayed).not.toContain(row.nativeSessionId);
});

it.each(["retained title", "saved location"])(
  "finds a joined official result using its %s without another lookup or preview",
  async (field) => {
    const local = saved(
      "saved-search",
      "Remember my original answer",
      "/owned/retained-search-location",
    );
    h.index.push(local);
    const row = official(
      local.nativeSessionId!,
      "A different official title",
      "/reported/search",
      local.id,
    );
    await lookup([row]);
    setQuery(field === "retained title" ? local.title! : local.cwd);
    expectMetadataOnly();
    expect(results()).toHaveLength(1);
    expect(text(results()[0])).toContain(row.title);
  },
);

it("keeps same-name official results associated with their own exact saved IDs", async () => {
  const first = saved("saved-first", "Retained first answer", "/owned/first");
  const second = saved(
    "saved-second",
    "Retained second answer",
    "/owned/second",
  );
  h.index.push(second, first);
  await lookup([
    official(
      first.nativeSessionId!,
      "Same official title",
      "/reported/first",
      first.id,
    ),
    official(
      second.nativeSessionId!,
      "Same official title",
      "/reported/second",
      second.id,
    ),
  ]);
  expectMetadataOnly();
  const displayed = results().map((row) => text(row));
  expect(displayed).toHaveLength(2);
  expect(displayed[0]).toContain(first.title);
  expect(displayed[0]).toContain(first.cwd);
  expect(displayed[0]).not.toContain(second.title);
  expect(displayed[0]).not.toContain(second.cwd);
  expect(displayed[1]).toContain(second.title);
  expect(displayed[1]).toContain(second.cwd);
  expect(displayed[1]).not.toContain(first.title);
  setQuery(second.title!);
  expect(results()).toHaveLength(1);
  expect(text(results()[0])).toContain(second.cwd);
  expectMetadataOnly();
});

it.each(["dangling saved ID", "not joined"])(
  "does not guess local metadata from a matching title or cwd for a result with %s",
  async (state) => {
    const officialTitle = "Shared title without an exact association";
    const officialCwd = "/reported/shared-location";
    h.index.push(
      saved("unrelated-title", officialTitle, "/owned/title-guess-only"),
      saved("unrelated-cwd", "Local cwd-guess-only title", officialCwd),
    );
    const row = official(
      "unlinked-native",
      officialTitle,
      officialCwd,
      state === "dangling saved ID" ? "missing-saved-id" : null,
    );
    await lookup([row]);
    expect(results()).toHaveLength(1);
    expect(text(results()[0])).toContain(officialTitle);
    expect(text(results()[0])).not.toContain("/owned/title-guess-only");
    expect(text(results()[0])).not.toContain("Local cwd-guess-only title");
    setQuery("Local cwd-guess-only title");
    expect(results()).toHaveLength(0);
    setQuery("/owned/title-guess-only");
    expect(results()).toHaveLength(0);
    expectMetadataOnly();
  },
);

it.each(["Agent", "native conversation"])(
  "does not show or search saved metadata when the exact ID belongs to a different %s",
  async (owner) => {
    const local = saved(
      "foreign-saved-id",
      "Private foreign retained title",
      "/owned/foreign-saved-location",
    );
    h.index.push({
      ...local,
      ...(owner === "Agent"
        ? { agentId: "b" }
        : { nativeSessionId: "different-native-owner" }),
    });
    const row = official(
      local.nativeSessionId!,
      "Official current owner",
      "/reported/current-owner",
      local.id,
    );
    await lookup([row]);
    expect(results()).toHaveLength(1);
    expect(text(results()[0])).toContain(row.title);
    expect(text(results()[0])).not.toContain(local.title);
    expect(text(results()[0])).not.toContain(local.cwd);
    setQuery(local.title!);
    expect(results()).toHaveLength(0);
    setQuery(local.cwd);
    expect(results()).toHaveLength(0);
    expectMetadataOnly();
  },
);

it("shows and searches metadata returned by the actual add workflow before the index snapshot contains it", async () => {
  const row = official(
    "newly-joined-native",
    "Official imported title",
    "/reported/imported",
  );
  const local = {
    ...saved(
      "new-saved-row",
      "Retained title after joining",
      "/owned/after-joining",
    ),
    nativeSessionId: row.nativeSessionId,
  };
  h.commit.mockResolvedValueOnce(local);
  await lookup([row]);
  const checkbox = render().find(
    (node) => node.type === "input" && node.props["aria-label"] === row.title,
  );
  expect(checkbox).toBeDefined();
  (checkbox!.props.onChange as () => void)();
  click(button(S.add));
  await idle();
  expect(h.preview).toHaveBeenCalledExactlyOnceWith("a", row);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.refresh).toHaveBeenCalledOnce();
  expect(h.index).toEqual([]);
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(h.prompt).not.toHaveBeenCalled();
  const displayed = text(results()[0]);
  expect(displayed).toContain(row.title);
  expect(displayed).toContain(local.title);
  expect(displayed).toContain(local.cwd);
  setQuery(local.title!);
  expect(results()).toHaveLength(1);
  setQuery(local.cwd);
  expect(results()).toHaveLength(1);
  const latest = {
    ...local,
    title: "Updated retained title in the current index",
    cwd: "/owned/updated-saved-location",
  };
  h.index.push(latest);
  setQuery(latest.title);
  expect(results()).toHaveLength(1);
  expect(text(results()[0])).toContain(latest.title);
  expect(text(results()[0])).toContain(latest.cwd);
  expect(text(results()[0])).not.toContain(local.title);
  expect(text(results()[0])).not.toContain(local.cwd);
  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledTimes(1);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(h.prompt).not.toHaveBeenCalled();
});

it("can inspect an already-joined row without previewing, opening, changing Agent, or sending", async () => {
  const local = saved(
    "inspect-saved",
    "Saved inspection target",
    "/owned/inspection",
  );
  h.index.push(local);
  const row = official(
    local.nativeSessionId!,
    "Official inspection title",
    "/reported/inspection",
    local.id,
  );
  await lookup([row]);
  const result = results()[0];
  const children = Children.toArray(result.props.children as ReactNode);
  const select = children.find(
    (child): child is Element =>
      isValidElement(child) && child.type === "button",
  );
  click(select);
  await idle();
  expect(button(S.open)).toBeDefined();
  setQuery(row.title!);
  expect(results()).toHaveLength(1);
  expectMetadataOnly();
});

it("opens only the latest exact joined row without previewing, importing, or sending", async () => {
  const local = saved(
    "open-exact",
    "Original retained opening target",
    "/owned/original-opening-target",
  );
  const decoy = saved("open-decoy", local.title!, local.cwd);
  h.index.push(decoy, local);
  const row = official(
    local.nativeSessionId!,
    "Official opening title",
    "/reported/opening-target",
    local.id,
  );
  await lookup([row]);
  const result = results()[0];
  const select = Children.toArray(result.props.children as ReactNode).find(
    (child): child is Element =>
      isValidElement(child) && child.type === "button",
  );
  click(select);
  await idle();
  const open = button(S.open);
  expect(open).toBeDefined();
  expect(open!.props.disabled).not.toBe(true);
  expectMetadataOnly();

  const latest = {
    ...local,
    title: "Latest exact retained opening target",
    cwd: "/owned/latest-opening-target",
    updatedAt: 2,
  };
  h.index.splice(0, h.index.length, decoy, latest);
  click(open);
  await idle();

  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(latest);
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.closePreview).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.choose).not.toHaveBeenCalled();
  expect(props.onPrepare).not.toHaveBeenCalled();
});

it.each(["Agent", "native conversation"])(
  "does not open an exact saved ID owned by a different %s",
  async (owner) => {
    const local = saved(
      "foreign-open-id",
      "Foreign saved opening title",
      "/owned/foreign-opening-target",
    );
    h.index.push({
      ...local,
      ...(owner === "Agent"
        ? { agentId: "b" }
        : { nativeSessionId: "foreign-opening-native" }),
    });
    const row = official(
      local.nativeSessionId!,
      "Official opening candidate",
      "/reported/opening-candidate",
      local.id,
    );
    await lookup([row]);
    const result = results()[0];
    const select = Children.toArray(result.props.children as ReactNode).find(
      (child): child is Element =>
        isValidElement(child) && child.type === "button",
    );
    click(select);
    await idle();

    const open = button(S.open);
    if (open && open.props.disabled !== true) {
      click(open);
      await idle();
    }

    expectMetadataOnly();
    expect(h.closePreview).not.toHaveBeenCalled();
    expect(text(results()[0])).not.toContain(local.title);
    expect(text(results()[0])).not.toContain(local.cwd);
  },
);

it.each(["Agent", "native conversation"])(
  "rechecks the current saved owner at click time after the rendered %s changes",
  async (owner) => {
    const local = saved(
      "late-opening-id",
      "Previously rendered opening title",
      "/owned/previously-rendered-opening-target",
    );
    h.index.push(local);
    const row = official(
      local.nativeSessionId!,
      "Official late opening candidate",
      "/reported/late-opening-candidate",
      local.id,
    );
    await lookup([row]);
    const result = results()[0];
    const select = Children.toArray(result.props.children as ReactNode).find(
      (child): child is Element =>
        isValidElement(child) && child.type === "button",
    );
    click(select);
    await idle();
    const open = button(S.open);
    expect(open).toBeDefined();
    expect(open!.props.disabled).not.toBe(true);
    expectMetadataOnly();

    const replacement = {
      ...local,
      title: "Replacement owner's private title",
      cwd: "/owned/replacement-owner",
      ...(owner === "Agent"
        ? { agentId: "b" }
        : { nativeSessionId: "replacement-native-owner" }),
    };
    h.index.splice(0, h.index.length, replacement);
    // Invoke the already-rendered action; no intervening render may make it safe.
    if (open && open.props.disabled !== true) click(open);
    await idle();

    expectMetadataOnly();
    expect(h.closePreview).not.toHaveBeenCalled();
    const displayed = text(results()[0]);
    expect(displayed).not.toContain(local.title);
    expect(displayed).not.toContain(local.cwd);
    expect(displayed).not.toContain(replacement.title);
    expect(displayed).not.toContain(replacement.cwd);
  },
);

async function addForDeletionLifecycle(suffix: string) {
  const row = official(
    `lifecycle-native-${suffix}`,
    `Official lifecycle result ${suffix}`,
    `/reported/lifecycle-${suffix}`,
  );
  const local = {
    ...saved(
      `lifecycle-saved-${suffix}`,
      `Retained lifecycle title ${suffix}`,
      `/owned/lifecycle-${suffix}`,
    ),
    nativeSessionId: row.nativeSessionId,
  };
  h.commit.mockResolvedValueOnce(local);
  await lookup([row]);
  const checkbox = render().find(
    (node) => node.type === "input" && node.props["aria-label"] === row.title,
  );
  expect(checkbox).toBeDefined();
  (checkbox!.props.onChange as () => void)();
  click(button(S.add));
  await idle();

  // A confirmed new save is usable while its first index refresh is still absent.
  expect(h.index).toEqual([]);
  expect(text(results()[0])).toContain(local.title);
  const select = Children.toArray(
    results()[0].props.children as ReactNode,
  ).find(
    (child): child is Element =>
      isValidElement(child) && child.type === "button",
  );
  click(select);
  await idle();
  const open = button(S.open);
  expect(open).toBeDefined();
  expect(open!.props.disabled).not.toBe(true);
  return { row, local, open: open! };
}

it("retires a committed fallback after the saved row appeared in the index and was deleted, including its captured Open action", async () => {
  const { row, local, open } = await addForDeletionLifecycle("deleted");
  h.index = [local];
  render();
  expect(text(results()[0])).toContain(local.title);

  h.index = [];
  render();
  const afterDeletion = text(results()[0]);
  const currentOpen = button(S.open);
  // An earlier enabled action is not authority to resurrect the deleted row.
  (open.props.onClick as () => void)();
  await idle();

  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledTimes(1);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(afterDeletion).toContain(row.title);
  expect(afterDeletion).not.toContain(local.title);
  expect(afterDeletion).not.toContain(local.cwd);
  expect(!currentOpen || currentOpen.props.disabled === true).toBe(true);
  setQuery(local.title!);
  expect(results()).toHaveLength(0);
});

it("does not restore a deleted committed fallback from another Agent's lookup draft after the modal was closed", async () => {
  const { row, local } = await addForDeletionLifecycle("closed-draft");
  h.index = [local];
  render();
  expect(text(results()[0])).toContain(local.title);

  props = { ...props, initialAgentId: "b", requestRevision: 2 };
  render();
  await idle();
  expect(results()).toHaveLength(0);
  props = { ...props, open: false };
  render();
  h.index = [];
  render();
  props = { ...props, open: true };
  render();
  await idle();
  props = { ...props, initialAgentId: "a", requestRevision: 3 };
  render();
  await idle();

  const restored = results()[0];
  expect(text(restored)).toContain(row.title);
  expect(text(restored)).not.toContain(local.title);
  expect(text(restored)).not.toContain(local.cwd);
  const select = Children.toArray(restored.props.children as ReactNode).find(
    (child): child is Element =>
      isValidElement(child) && child.type === "button",
  );
  click(select);
  await idle();
  const open = button(S.open);
  expect(!open || open.props.disabled === true).toBe(true);
  setQuery(local.title!);
  expect(results()).toHaveLength(0);
  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledTimes(1);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("rechecks an unindexed new save after releasing the preview yields to a different index snapshot", async () => {
  const { open } = await addForDeletionLifecycle("release-snapshot");
  // Start the enabled action, then replace the snapshot before its await resumes.
  (open.props.onClick as () => void)();
  h.index = [];
  await idle();

  expect(props.onOpen).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(h.discover).toHaveBeenCalledTimes(1);
  expect(h.preview).toHaveBeenCalledTimes(1);
  expect(h.closePreview).toHaveBeenCalledTimes(1);
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.choose).not.toHaveBeenCalled();
  expect(props.onPrepare).not.toHaveBeenCalled();
});
