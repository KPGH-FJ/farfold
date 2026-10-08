import { fileBasename } from "./file_paths";
import { SIDEBAR_STRINGS } from "./sidebar_strings";
/**
 * Sidebar view-model helpers (pure, unit-tested): row shape, per-project
 * grouping, and relative-time display. Lives apart from the thread store
 * to keep `sessions.ts` under the file-size cap; `sessions.ts` re-exports
 * these so existing imports keep working.
 */
import type { AgentOnlyRow, IndexRow, ThreadState } from "./sessions";
import { hasActiveTools, hasPendingRequests } from "./session_types";
import { hasUnsentWork } from "./drafts";

export interface SidebarRow {
  key: string;
  title: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string | null;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
  /** `need` | `run` | `idle` — live state overlays the index row. */
  status: "need" | "run" | "idle";
  /** Display only: a stopped/failed reply left official tools unconfirmed. */
  toolTailUnconfirmed?: boolean;
  unread?: boolean;
  live: boolean;
  /** `agent` = agent-side session with no index row yet (limited menu). */
  source: "meta" | "agent";
}

export function basename(path: string): string {
  return fileBasename(path);
}

/** `~/…` home-prefix缩写 + 超长时中段省略（状态栏/窄空间显示）。 */
export function shortPath(path: string, max = 48): string {
  const p = path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^[a-z]:[\\/]Users[\\/][^\\/]+/i, "~");
  if (p.length <= max) return p;
  const keep = Math.floor((max - 1) / 2);
  return `${p.slice(0, keep)}…${p.slice(p.length - keep)}`;
}

/** Mirrors `threads.needsAttention` — pure predicate over thread state. */
function needsAttention(s: ThreadState): boolean {
  return (
    Boolean(s.openError) ||
    s.unrecoverable ||
    s.stopUnconfirmed ||
    s.modelDrift ||
    Boolean(
      s.permissionConfigId &&
      ["required", "unknown"].includes(s.permissionState),
    ) ||
    Boolean(s.uncertainPrompt) ||
    s.queuePaused === "no_result" ||
    hasPendingRequests(s) ||
    s.connectionOutcomeUnknown
  );
}

/** Keep the official activity untouched; its last reply ending only changes
 * how a remaining tool is described. A newer request cannot inherit it. */
function toolTailUnconfirmed(s: ThreadState): boolean {
  if (
    s.running ||
    s.submitting ||
    s.reconnecting ||
    s.configuring ||
    s.stopping ||
    !hasActiveTools(s) ||
    hasPendingRequests(s)
  )
    return false;
  for (let i = s.items.length - 1; i >= 0; i -= 1) {
    const item = s.items[i];
    if (item.kind === "user") return false;
    if (item.kind === "settled")
      return item.status === "stopped" || item.status === "failed";
  }
  return false;
}

/** Merge index rows (plus agent-side `session/list` rows) with live
 *  thread state, then group by project directory. Pinned first, then
 *  attention > running > idle, then `updatedAt` desc within a group.
 *  Groups sorted by latest activity.
 *
 *  Archive membership comes from saved organization metadata; rendering never
 *  silently archives or restores a conversation. */
export function groupSidebarRows(
  rows: IndexRow[],
  live: Map<string, ThreadState>,
  opts: {
    archived?: boolean;
    attentionOnly?: boolean;
    agentRows?: AgentOnlyRow[];
    autoArchiveDays?: number;
  } = {},
): { project: string; cwd: string; rows: SidebarRow[] }[] {
  const groups = new Map<string, SidebarRow[]>();
  const push = (item: SidebarRow, effectiveArchived: boolean) => {
    if (effectiveArchived !== Boolean(opts.archived)) return;
    const list = groups.get(item.cwd) ?? [];
    list.push(item);
    groups.set(item.cwd, list);
  };
  for (const row of rows) {
    const liveState = live.get(row.id);
    const unconfirmedTail = liveState ? toolTailUnconfirmed(liveState) : false;
    const status: SidebarRow["status"] = liveState
      ? needsAttention(liveState) || unconfirmedTail
        ? "need"
        : liveState.running || hasActiveTools(liveState)
          ? "run"
          : "idle"
      : "idle";
    if (opts.attentionOnly && status !== "need") continue;
    push(
      {
        key: row.id,
        title: row.title || SIDEBAR_STRINGS.untitled,
        agentId: row.agentId,
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        pinned: row.pinned,
        archived: row.archived,
        updatedAt: row.updatedAt,
        status,
        toolTailUnconfirmed: unconfirmedTail,
        live: liveState !== undefined,
        source: "meta",
      },
      row.archived &&
        status === "idle" &&
        !hasUnsentWork(row.id) &&
        !liveState?.queued.length &&
        !liveState?.submitting &&
        !liveState?.configuring &&
        !liveState?.reconnecting &&
        !liveState?.stopping,
    );
  }
  for (const row of opts.agentRows ?? []) {
    if (opts.attentionOnly) continue;
    // Dedup guard: meta rows win (backend merge already drops covered
    // native ids; this is belt-and-suspenders for stale snapshots).
    if (rows.some((meta) => meta.id === row.key)) continue;
    push(
      {
        key: row.key,
        title: row.title || SIDEBAR_STRINGS.untitled,
        agentId: row.agentId,
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        pinned: false,
        archived: false,
        updatedAt: row.updatedAt,
        status: "idle",
        live: false,
        source: "agent",
      },
      false,
    );
  }

  const rank = (row: SidebarRow) =>
    row.status === "need" ? 0 : row.status === "run" ? 1 : 2;
  const out = [...groups.entries()].map(([cwd, items]) => {
    items.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        rank(a) - rank(b) ||
        b.updatedAt - a.updatedAt,
    );
    return { project: basename(cwd), cwd, rows: items };
  });
  out.sort(
    (a, b) =>
      Math.max(...b.rows.map((r) => r.updatedAt)) -
      Math.max(...a.rows.map((r) => r.updatedAt)),
  );
  return out;
}

export function relativeTime(millis: number, now = Date.now()): string {
  if (!millis) return "";
  const diff = Math.max(0, now - millis);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return SIDEBAR_STRINGS.justNow;
  if (min < 60) return SIDEBAR_STRINGS.minutesAgo(min);
  const hours = Math.floor(min / 60);
  if (hours < 24) return SIDEBAR_STRINGS.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return SIDEBAR_STRINGS.daysAgo(days);
  const months = Math.floor(days / 30);
  if (months < 12) return SIDEBAR_STRINGS.monthsAgo(months);
  return SIDEBAR_STRINGS.yearsAgo(Math.floor(months / 12));
}
