/**
 * ⌘K 命令面板（F-command-palette）：会话模糊搜索 + 底部命令。
 * 选中会话 = 切换；选中命令 = 执行。esc 关闭。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import {
  basename,
  relativeTime,
  threads,
  useThreadsSnapshot,
  type IndexRow,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

interface PaletteEntry {
  id: string;
  group: "threads" | "actions";
  label: string;
  right?: string;
  cls?: string;
  letter?: string;
  status?: "need" | "run" | "idle";
  run: () => void;
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = text.toLowerCase();
  if (hay.includes(q)) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return false;
}

export function CommandPalette({
  agents,
  onClose,
  onNew,
  onSelect,
  onSettings,
  onArchive,
  activeKey,
}: {
  agents: AgentCardModel[];
  onClose: () => void;
  onNew: () => void;
  onSelect: (row: IndexRow) => void;
  onSettings: () => void;
  onArchive: (rowId: string, archived: boolean) => void;
  activeKey: string | null;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const snapshot = useThreadsSnapshot();

  const agentById = useMemo(() => {
    const map = new Map<string, AgentCardModel>();
    for (const card of agents) map.set(card.id, card);
    return map;
  }, [agents]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const out: PaletteEntry[] = [];
    const rows = [...snapshot.index]
      .filter((r) => !r.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const row of rows) {
      const card = agentById.get(row.agentId);
      const hay = `${row.title ?? ""} ${basename(row.cwd)} ${card?.name ?? row.agentId}`;
      if (!fuzzyMatch(query, hay)) continue;
      const live = snapshot.threads.get(row.id);
      const status = live
        ? threads.needsAttention(live)
          ? "need"
          : live.running
            ? "run"
            : "idle"
        : "idle";
      const ident = card
        ? agentIdentity(card.id, card.name)
        : { letter: "?", cls: "other" };
      out.push({
        id: `t-${row.id}`,
        group: "threads",
        label: row.title || STRINGS.sessions.untitled,
        right: `${basename(row.cwd)} · ${relativeTime(row.updatedAt)}`,
        cls: ident.cls,
        letter: ident.letter,
        status,
        run: () => onSelect(row),
      });
    }
    const actions: PaletteEntry[] = [
      {
        id: "a-new",
        group: "actions",
        label: STRINGS.palette.newChat,
        right: "⌘N",
        run: onNew,
      },
      {
        id: "a-settings",
        group: "actions",
        label: STRINGS.palette.openSettings,
        run: onSettings,
      },
    ];
    if (activeKey) {
      const row = snapshot.index.find((r) => r.id === activeKey);
      if (row) {
        actions.push({
          id: "a-archive",
          group: "actions",
          label: row.archived
            ? STRINGS.palette.unarchiveCurrent
            : STRINGS.palette.archiveCurrent,
          run: () => onArchive(row.id, !row.archived),
        });
      }
    }
    for (const action of actions) {
      if (fuzzyMatch(query, action.label)) out.push(action);
    }
    return out;
  }, [
    snapshot,
    query,
    agentById,
    onSelect,
    onNew,
    onSettings,
    onArchive,
    activeKey,
  ]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector(".pal-item.sel");
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, entries]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((v) => Math.min(entries.length - 1, v + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((v) => Math.max(0, v - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[sel];
      if (entry) {
        onClose();
        entry.run();
      }
    }
  };

  let lastGroup: string | null = null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="pal-input"
          autoFocus
          placeholder={STRINGS.palette.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="pal-list" ref={listRef}>
          {entries.length === 0 && (
            <div className="pal-empty">{STRINGS.palette.empty}</div>
          )}
          {entries.map((entry, i) => {
            const showLabel = entry.group !== lastGroup;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {showLabel && (
                  <div className="pal-label">
                    {entry.group === "threads"
                      ? STRINGS.palette.groupSessions
                      : STRINGS.palette.groupActions}
                  </div>
                )}
                <div
                  className={`pal-item${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => {
                    onClose();
                    entry.run();
                  }}
                >
                  {entry.letter && (
                    <span className={`id ${entry.cls}`}>{entry.letter}</span>
                  )}
                  <span>{entry.label}</span>
                  {entry.status === "need" && (
                    <span className="st need">{STRINGS.sessions.needYou}</span>
                  )}
                  {entry.status === "run" && (
                    <span className="st run">{STRINGS.sessions.running}</span>
                  )}
                  {entry.right && <span className="r">{entry.right}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span>↑↓ {STRINGS.palette.move}</span>
          <span>↵ {STRINGS.palette.confirm}</span>
          <span>esc {STRINGS.palette.close}</span>
          <span className="p-note">{STRINGS.palette.hint}</span>
        </div>
      </div>
    </div>
  );
}
