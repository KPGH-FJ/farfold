import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SidebarRow } from "../runtime/sidebar";
import type { LibraryFilter } from "../runtime/collections";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[] }[],
  effects: [] as (() => void)[],
  groups: [] as { id: string; name: string }[],
  rows: [] as SidebarRow[],
  blockers: new Map<string, string>(),
  remove: vi.fn(),
  assign: vi.fn(),
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
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = h.cursor++;
    const prior = h.slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps?.[i])))
      h.effects.push(effect);
    h.slots[index] = { deps };
  },
}));
const snapshot = () => ({
  index: h.rows.map((row) => ({ ...row, id: row.key })),
  threads: new Map(),
});
vi.mock("../runtime/sessions", async () => ({
  ...(await import("../runtime/sidebar")),
  threads: {
    subscribe: () => () => {},
    getSnapshot: () => snapshot(),
    archiveBlockReason: (key: string) => h.blockers.get(key) ?? null,
    delete: h.remove,
  },
  useThreadsSnapshot: () => snapshot(),
}));
vi.mock("../runtime/collections", async (original) => ({
  ...(await original<typeof import("../runtime/collections")>()),
  collections: { assign: h.assign },
  useCollections: () => ({
    ready: true,
    saving: false,
    error: null,
    groups: h.groups,
    assignments: {},
  }),
  useLibraryRows: (archived: boolean) =>
    h.rows.filter((row) => row.archived === archived),
}));
import { ConversationLibrary } from "./ConversationLibrary";
import { DeleteConversationsDialog } from "./DeleteConversationsDialog";
import { LIBRARY } from "../runtime/library_strings";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";

type Element = ReactElement<Record<string, unknown>>;
let filter: LibraryFilter;
const onFilter = vi.fn();
function render() {
  h.cursor = 0;
  const tree = ConversationLibrary({
    agents: [],
    filter,
    onFilter,
    onOpen: vi.fn(),
    onImport: vi.fn(),
    onNew: vi.fn(),
    defaultCwd: null,
  });
  const pending = h.effects.splice(0);
  if (pending.length) {
    pending.forEach((effect) => effect());
    return render();
  }
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return nodes;
}
function clearArchived() {
  const button = render().find(
    (node) =>
      node.type === "button" && node.props.children === LIBRARY.clearArchived,
  )!;
  expect(button).toBeDefined();
  (button.props.onClick as (event: unknown) => void)({ currentTarget: null });
}
function confirmation() {
  return render().find((node) => node.type === DeleteConversationsDialog)!;
}
function confirm() {
  (confirmation().props.onDelete as () => void)();
}
function row(key: string, agentId = "one"): SidebarRow {
  return {
    key,
    title: `${key} title`,
    agentId,
    cwd: "/work",
    nativeSessionId: key,
    pinned: false,
    archived: true,
    updatedAt: 1,
    status: "idle",
    live: false,
    source: "meta",
  };
}
beforeEach(() => {
  h.cursor = 0;
  h.slots.length = 0;
  h.effects.length = 0;
  h.rows = [row("selected"), row("outside", "other")];
  h.blockers.clear();
  h.remove.mockReset().mockResolvedValue("deleted");
  h.assign.mockReset().mockResolvedValue(undefined);
  filter = {
    kind: "selection",
    state: "archived",
    agent: "one",
    group: "",
    query: "",
    favorites: false,
  };
});

it("freezes the reviewed filtered archive set and excludes conversations entering it later", async () => {
  clearArchived();
  expect(confirmation().props.targets).toEqual(["selected title"]);
  expect(confirmation().props.hint).toBe(R.archivedScope(1));
  h.rows.push(row("archived-later"));
  expect(confirmation().props.targets).toEqual(["selected title"]);
  expect(confirmation().props.hint).toBe(R.archivedScope(1));
  confirm();
  await vi.waitFor(() => expect(h.remove).toHaveBeenCalledOnce());
  expect(h.remove).toHaveBeenCalledWith(
    expect.objectContaining({ key: "selected" }),
  );
  await vi.waitFor(() =>
    expect(h.assign).toHaveBeenCalledExactlyOnceWith(["selected"], ""),
  );
  expect(h.rows.map((item) => item.key)).toEqual([
    "selected",
    "outside",
    "archived-later",
  ]);
});

it("rechecks every reviewed item before deleting any when activity starts after confirmation opens", async () => {
  h.rows.push(row("second"));
  clearArchived();
  expect(confirmation().props.targets).toEqual([
    "selected title",
    "second title",
  ]);
  h.blockers.set("second", "running");
  confirm();
  await vi.waitFor(() =>
    expect(confirmation().props.error).toBe(LIBRARY.deleteReasons.running),
  );
  expect(h.remove).not.toHaveBeenCalled();
  expect(h.assign).not.toHaveBeenCalled();
  expect(confirmation().props.targets).toEqual([
    "selected title",
    "second title",
  ]);
});

it("rejects the whole reviewed request when one conversation is restored from archive", async () => {
  h.rows.push(row("second"));
  clearArchived();
  h.rows = h.rows.map((item) =>
    item.key === "second" ? { ...item, archived: false } : item,
  );
  confirm();
  await vi.waitFor(() =>
    expect(confirmation().props.error).toBe(R.archivedChanged),
  );
  expect(h.remove).not.toHaveBeenCalled();
  expect(h.assign).not.toHaveBeenCalled();
  expect(confirmation().props.targets).toEqual([
    "selected title",
    "second title",
  ]);
});
