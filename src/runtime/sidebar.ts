/**
 * Sidebar view-model helpers (pure, unit-tested): row shape, per-project
 * grouping, and relative-time display. Lives apart from the thread store
 * to keep `sessions.ts` under the file-size cap; `sessions.ts` re-exports
 * these so existing imports keep working.
 */
import type { AgentOnlyRow, IndexRow, ThreadState } from "./sessions";

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
  live: boolean;
  /** `agent` = agent-side session with no index row yet (limited menu). */
  source: "meta" | "agent";
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.split("/").pop();
  return name || trimmed || path;
}

/** `~/…` home-prefix缩写 + 超长时中段省略（状态栏/窄空间显示）。 */
export function shortPath(path: string, max = 48): string {
  const p = path.replace(/^\/Users\/[^/]+/, "~");
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
    s.pendingPermissions.length > 0 ||
    s.pendingElicitation !== null ||
    (s.connectionLost && s.items.length > 0)
  );
}

/** Merge index rows (plus agent-side `session/list` rows) with live
 *  thread state, then group by project directory. Pinned first, then
 *  attention > running > idle, then `updatedAt` desc within a group.
 *  Groups sorted by latest activity.
 *
 *  Auto-archive is view-grouping only: idle, unpinned rows untouched for
 *  `autoArchiveDays` days count as archived without touching the DB. */
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
  const cutoff =
    opts.autoArchiveDays && opts.autoArchiveDays > 0
      ? Date.now() - opts.autoArchiveDays * 86_400_000
      : null;
  const autoArchived = (
    pinned: boolean,
    status: SidebarRow["status"],
    updatedAt: number,
  ) => cutoff !== null && !pinned && status === "idle" && updatedAt < cutoff;

  const groups = new Map<string, SidebarRow[]>();
  const push = (item: SidebarRow, effectiveArchived: boolean) => {
    if (effectiveArchived !== Boolean(opts.archived)) return;
    const list = groups.get(item.cwd) ?? [];
    list.push(item);
    groups.set(item.cwd, list);
  };
  for (const row of rows) {
    const liveState = live.get(row.id);
    const status: SidebarRow["status"] = liveState
      ? needsAttention(liveState)
        ? "need"
        : liveState.running
          ? "run"
          : "idle"
      : "idle";
    if (opts.attentionOnly && status !== "need") continue;
    push(
      {
        key: row.id,
        title: row.title || "未命名会话",
        agentId: row.agentId,
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        pinned: row.pinned,
        archived: row.archived,
        updatedAt: row.updatedAt,
        status,
        live: liveState !== undefined,
        source: "meta",
      },
      row.archived || autoArchived(row.pinned, status, row.updatedAt),
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
        title: row.title || "未命名会话",
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
      autoArchived(false, "idle", row.updatedAt),
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
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}
