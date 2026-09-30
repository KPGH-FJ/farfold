import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { LIBRARY } from "./library_strings";
import { groupSidebarRows, type SidebarRow } from "./sidebar";
import { useThreadsSnapshot } from "./sessions";
import { useConversationReadState } from "./conversation_read_state";

export interface ConversationGroup {
  id: string;
  name: string;
}
export interface CollectionData {
  groups: ConversationGroup[];
  assignments: Record<string, string>;
}
interface CollectionState extends CollectionData {
  ready: boolean;
  saving: boolean;
  error: string | null;
}
export interface LibrarySelection {
  agent: string;
  group: string;
  favorites: boolean;
  state: "all" | "need" | "run" | "unread" | "archived";
  query: string;
}
export type LibraryFilter =
  | { kind: "all" | "favorites" | "attention" | "running" | "unread" }
  | { kind: "agent" | "group"; id: string }
  | ({ kind: "selection" } & LibrarySelection);

export function normalizeLibraryFilter(
  filter: LibraryFilter,
): LibrarySelection {
  if (filter.kind === "selection") {
    const { agent, group, favorites, state, query } = filter;
    return { agent, group, favorites, state, query };
  }
  return {
    agent: filter.kind === "agent" ? filter.id : "",
    group: filter.kind === "group" ? filter.id : "",
    favorites: filter.kind === "favorites",
    state:
      filter.kind === "attention"
        ? "need"
        : filter.kind === "running"
          ? "run"
          : filter.kind === "unread"
            ? "unread"
            : "all",
    query: "",
  };
}

/** A control replaces its own navigation dimension; it does not intersect
 * two mutually exclusive Agents/groups and leave a misleading empty list. */
export function libraryDimensions(
  filter: LibraryFilter,
  agent: string | null,
  group: string | null,
) {
  const selection = normalizeLibraryFilter(filter);
  return {
    agent: agent ?? selection.agent,
    group: group ?? selection.group,
    favorites: selection.favorites,
  };
}

export function parseCollections(value: unknown): CollectionData {
  const empty: CollectionData = { groups: [], assignments: {} };
  if (!value || typeof value !== "object") return empty;
  const raw = value as Partial<CollectionData>;
  const ids = new Set<string>();
  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((g) => {
      if (
        !g ||
        typeof g.id !== "string" ||
        typeof g.name !== "string" ||
        !g.name.trim() ||
        ids.has(g.id)
      )
        return false;
      ids.add(g.id);
      return true;
    })
    .map((g) => ({ id: g.id, name: g.name.trim() }));
  const assignments: Record<string, string> = {};
  if (raw.assignments && typeof raw.assignments === "object") {
    for (const [key, id] of Object.entries(raw.assignments))
      if (typeof id === "string" && ids.has(id)) assignments[key] = id;
  }
  return { groups, assignments };
}

let state: CollectionState = {
  groups: [],
  assignments: {},
  ready: false,
  saving: false,
  error: null,
};
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
function publish(next: CollectionState) {
  state = next;
  listeners.forEach((f) => f());
}
export const collections = {
  snapshot: () => state,
  subscribe: (f: () => void) => {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
  load(): Promise<void> {
    if (state.ready) return Promise.resolve();
    return (loading ??= invoke<unknown>("settings_get", {
      key: "conversationGroups.v1",
    })
      .then((value) =>
        publish({
          ...parseCollections(value),
          ready: true,
          saving: false,
          error: null,
        }),
      )
      .catch(() => {
        publish({ ...state, error: LIBRARY.loadError });
        throw new Error(LIBRARY.loadError);
      })
      .finally(() => {
        loading = null;
      }));
  },
  update(transform: (data: CollectionData) => CollectionData): Promise<void> {
    const next = writes
      .catch(() => undefined)
      .then(async () => {
        await collections.load();
        try {
          const data = transform({
            groups: state.groups.map((group) => ({ ...group })),
            assignments: { ...state.assignments },
          });
          publish({ ...state, saving: true, error: null });
          await invoke("settings_set", {
            key: "conversationGroups.v1",
            value: data,
          });
          publish({ ...data, ready: true, saving: false, error: null });
        } catch {
          publish({ ...state, saving: false, error: LIBRARY.saveError });
          throw new Error(LIBRARY.saveError);
        }
      });
    writes = next;
    return next;
  },
  create(name: string) {
    return collections.update((data) => ({
      ...data,
      groups: [
        ...data.groups,
        { id: crypto.randomUUID(), name: groupName(name) },
      ],
    }));
  },
  rename(id: string, name: string) {
    return collections.update((data) => {
      const nextName = groupName(name);
      return {
        ...data,
        groups: data.groups.map((g) =>
          g.id === id ? { ...g, name: nextName } : g,
        ),
      };
    });
  },
  remove(id: string) {
    return collections.update((data) => ({
      groups: data.groups.filter((g) => g.id !== id),
      assignments: Object.fromEntries(
        Object.entries(data.assignments).filter(([, group]) => group !== id),
      ),
    }));
  },
  assign(keys: string[], group: string) {
    return collections.update((data) => {
      if (group && !data.groups.some((g) => g.id === group))
        throw new Error(LIBRARY.saveError);
      const assignments = { ...data.assignments };
      for (const key of keys) {
        if (group) assignments[key] = group;
        else delete assignments[key];
      }
      return { ...data, assignments };
    });
  },
};
function groupName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(LIBRARY.saveError);
  return trimmed;
}

/** Mutations finish after a dialog closes, but their feedback belongs to that view only. */
export class CollectionActionScope {
  private revision = 0;
  private running = false;
  invalidate() {
    this.revision++;
  }
  async run<T>(
    work: () => Promise<T>,
    callbacks: {
      pending: (busy: boolean) => void;
      success?: (result: T) => void;
      failure: (reason: unknown) => void;
    },
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    const ticket = this.revision;
    callbacks.pending(true);
    try {
      const result = await work();
      if (ticket === this.revision) callbacks.success?.(result);
    } catch (reason) {
      if (ticket === this.revision) callbacks.failure(reason);
    } finally {
      this.running = false;
      callbacks.pending(false);
    }
  }
}

export function selectedLibraryRows(
  rows: SidebarRow[],
  selected: ReadonlySet<string>,
) {
  return rows.filter((row) => selected.has(row.key));
}
export function toggleVisibleSelection(
  rows: SidebarRow[],
  selected: ReadonlySet<string>,
) {
  const next = new Set(selected);
  const allSelected =
    rows.length > 0 && rows.every((row) => selected.has(row.key));
  for (const row of rows) {
    if (allSelected) next.delete(row.key);
    else next.add(row.key);
  }
  return next;
}
export function useCollections() {
  const value = useSyncExternalStore(
    collections.subscribe,
    collections.snapshot,
  );
  useEffect(() => {
    void collections.load().catch(() => undefined);
  }, []);
  return value;
}
export function useLibraryRows(archived = false): SidebarRow[] {
  const snapshot = useThreadsSnapshot();
  const readState = useConversationReadState();
  return groupSidebarRows(snapshot.index, snapshot.threads, {
    archived,
    autoArchiveDays: snapshot.autoArchiveDays,
  })
    .flatMap((g) => g.rows)
    .map((row) => ({ ...row, unread: readState.unread.has(row.key) }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    );
}
export function matchesLibraryFilter(
  row: SidebarRow,
  filter: LibraryFilter,
  data: CollectionData,
) {
  const selected = normalizeLibraryFilter(filter);
  return (
    (!selected.favorites || row.pinned) &&
    (!selected.agent || row.agentId === selected.agent) &&
    (!selected.group ||
      (selected.group === "none"
        ? !data.assignments[row.key]
        : data.assignments[row.key] === selected.group)) &&
    (selected.state === "all" ||
      (selected.state === "archived"
        ? row.archived
        : selected.state === "unread"
          ? !!row.unread
          : row.status === selected.state)) &&
    (!selected.query.trim() ||
      `${row.title} ${row.cwd} ${row.agentId} ${data.groups.find((group) => group.id === data.assignments[row.key])?.name ?? ""}`
        .toLocaleLowerCase()
        .includes(selected.query.trim().toLocaleLowerCase()))
  );
}
