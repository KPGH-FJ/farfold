import { paneCards } from "./artifacts";
import { reportedFileSources, type ReportedFile } from "./file_delivery";
import type { ThreadItem, ThreadState, ToolCallView } from "./session_types";

export type ArtifactToolItem = Extract<ThreadItem, { kind: "tool" }>;
export type ReportedArtifactOrigin = Readonly<{
  toolItemId: string;
  toolCallId: string;
  source: ReportedFile["source"];
}>;
export type ReportedArtifactFile = Readonly<{
  key: string;
  path: string;
  origins: readonly ReportedArtifactOrigin[];
}>;

/** Resolve existing in-memory references only. Missing is not "all rounds". */
export function scopedArtifactToolItems(
  thread: ThreadState,
  scopeId: string | null,
): ArtifactToolItem[] | null {
  const tools = thread.items.filter(
    (item): item is ArtifactToolItem => item.kind === "tool",
  );
  if (new Set(tools.map((item) => item.id)).size !== tools.length) return null;
  if (scopeId === null) return tools;
  const matches = thread.items.filter((item) => item.id === scopeId);
  if (matches.length !== 1) return null;
  const scope = matches[0];
  if (scope.kind === "tool") return [scope];
  if (scope.kind !== "settled" || !scope.artifactToolItemIds) return null;
  const ids = new Set(scope.artifactToolItemIds);
  const selected = tools.filter((item) => ids.has(item.id));
  return selected.length === ids.size ? selected : null;
}

type OriginSnapshot = {
  item: ArtifactToolItem;
  call: ToolCallView;
  origin: ReportedArtifactOrigin;
};
type EntrySnapshot = {
  thread: ThreadState;
  threadKey: string;
  cwd: string;
  scopeId: string | null;
  scope: ThreadItem | null;
  origins: OriginSnapshot[];
};
// These weak references prove only live report membership, never disk existence.
const snapshots = new WeakMap<ReportedArtifactFile, EntrySnapshot>();

export function reportedArtifactFiles(
  thread: ThreadState,
  scopeId: string | null,
): readonly ReportedArtifactFile[] | null {
  const tools = scopedArtifactToolItems(thread, scopeId);
  if (!tools) return null;
  const paths = new Map<string, OriginSnapshot[]>();
  for (const item of tools) {
    for (const report of reportedFileSources(item.call)) {
      const origins = paths.get(report.path) ?? [];
      origins.push({
        item,
        call: item.call,
        origin: Object.freeze({
          toolItemId: item.id,
          toolCallId: report.toolCallId,
          source: report.source,
        }),
      });
      paths.set(report.path, origins);
    }
  }
  return Object.freeze(
    [...paths].map(([path, origins]) => {
      const entry = Object.freeze({
        key: JSON.stringify([thread.key, thread.cwd, path]),
        path,
        origins: Object.freeze(origins.map((value) => value.origin)),
      });
      snapshots.set(entry, {
        thread,
        threadKey: thread.key,
        cwd: thread.cwd,
        scopeId,
        scope:
          scopeId === null
            ? null
            : (thread.items.find((item) => item.id === scopeId) ?? null),
        origins,
      });
      return entry;
    }),
  );
}

/** Recheck immediately before a user action; a copied entry grants no authority. */
export function isReportedArtifactCurrent(
  thread: ThreadState,
  scopeId: string | null,
  entry: ReportedArtifactFile,
): boolean {
  const saved = snapshots.get(entry);
  if (
    !saved ||
    saved.thread !== thread ||
    saved.threadKey !== thread.key ||
    saved.cwd !== thread.cwd ||
    saved.scopeId !== scopeId ||
    (scopeId !== null &&
      thread.items.find((item) => item.id === scopeId) !== saved.scope)
  )
    return false;
  const tools = scopedArtifactToolItems(thread, scopeId);
  if (!tools) return false;
  let index = 0;
  for (const item of tools) {
    for (const report of reportedFileSources(item.call)) {
      if (report.path !== entry.path) continue;
      const previous = saved.origins[index++];
      if (
        !previous ||
        previous.item !== item ||
        previous.call !== item.call ||
        previous.origin.toolItemId !== item.id ||
        previous.origin.toolCallId !== report.toolCallId ||
        previous.origin.source !== report.source
      )
        return false;
    }
  }
  return index === saved.origins.length && index > 0;
}

/** Files/diffs share a path count; each nonempty command/log remains an output. */
export function reportedArtifactCount(
  thread: ThreadState,
  scopeId: string | null,
): number | null {
  const tools = scopedArtifactToolItems(thread, scopeId);
  if (!tools) return null;
  return combinedCount(tools.map((item) => toolStats(thread, item)));
}

type ToolStats = { paths: Set<string>; outputs: number };
function toolStats(thread: ThreadState, item: ArtifactToolItem): ToolStats {
  const paths = new Set(
    reportedFileSources(item.call).map((report) => report.path),
  );
  let outputs = 0;
  // This clipped view is only a count input, never used for entry authority.
  for (const card of paneCards({ ...thread, items: [item] })) {
    if (card.kind === "diff") paths.add(card.path);
    else if (card.output.length > 0) outputs++;
  }
  return { paths, outputs };
}
function combinedCount(stats: readonly ToolStats[]): number {
  const paths = new Set<string>();
  let outputs = 0;
  for (const value of stats) {
    for (const path of value.paths) paths.add(path);
    outputs += value.outputs;
  }
  return paths.size + outputs;
}

/** Compute transcript counts once, without rescanning all tools for each row. */
export function reportedArtifactCounts(
  thread: ThreadState,
): ReadonlyMap<string, number | null> {
  const ids = new Map<string, number>();
  const tools = new Map<string, ToolStats>();
  let ambiguousTools = false;
  for (const item of thread.items) {
    ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
    if (item.kind !== "tool") continue;
    if (tools.has(item.id)) ambiguousTools = true;
    tools.set(item.id, toolStats(thread, item));
  }
  const result = new Map<string, number | null>();
  for (const item of thread.items) {
    if (item.kind !== "tool" && item.kind !== "settled") continue;
    if (ambiguousTools || ids.get(item.id) !== 1) {
      result.set(item.id, null);
      continue;
    }
    if (item.kind === "tool") {
      result.set(item.id, combinedCount([tools.get(item.id)!]));
      continue;
    }
    if (!item.artifactToolItemIds) {
      result.set(item.id, null);
      continue;
    }
    const referenced = [...new Set(item.artifactToolItemIds)].map((id) =>
      tools.get(id),
    );
    result.set(
      item.id,
      referenced.every((value): value is ToolStats => value !== undefined)
        ? combinedCount(referenced)
        : null,
    );
  }
  return result;
}
