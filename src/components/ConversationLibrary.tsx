import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ChatCircleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  StarIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import { isAgentPresentable } from "../runtime/agent_directory";
import {
  CollectionActionScope,
  collections,
  normalizeLibraryFilter,
  selectedLibraryRows,
  toggleVisibleSelection,
  useCollections,
  useLibraryRows,
  type LibraryFilter,
  type LibrarySelection,
} from "../runtime/collections";
import { LIBRARY } from "../runtime/library_strings";
import { useArchiveBlockReasons } from "../runtime/archive_blockers";
import { uiError } from "../runtime/ui_error";
import {
  basename,
  relativeTime,
  threads,
  useThreadsSnapshot,
  type SidebarRow,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { settledRoundResults } from "../runtime/round_result";
import { hasReadableMessages } from "../runtime/message_attachments";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { AgentLogo } from "./AgentLogo";
import { composerDrafts } from "../runtime/drafts";
import { ResumeDraftButton } from "./ResumeDraftButton";
import { MoveConversationsDialog } from "./MoveConversationsDialog";
import {
  conversationReadState,
  useConversationReadState,
} from "../runtime/conversation_read_state";

const LIBRARY_TABS = [
  ["all", LIBRARY.allTab],
  ["need", LIBRARY.attention],
  ["run", LIBRARY.running],
  ["unread", LIBRARY.unread],
  ["archived", LIBRARY.archived],
] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number][0];

/** Derive only from loaded events; an index timestamp is never an ending. */
function loadedResult(state: ThreadState | undefined) {
  if (
    !state ||
    state.submitting ||
    state.reconnecting ||
    state.configuring ||
    state.stopping
  )
    return null;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    // A newer message must not inherit an older round's result.
    if (item.kind === "user") return null;
    if (item.kind !== "settled") continue;
    if (item.status !== "done")
      return {
        label: STRINGS.thread[item.status],
        title: item.error,
        attention: item.status !== "stopped",
      };
    const result = settledRoundResults(state).get(item.id);
    return {
      label:
        result === "reply"
          ? STRINGS.thread.done
          : result === "none"
            ? LIBRARY.noResult
            : result === "pending"
              ? LIBRARY.running
              : STRINGS.thread.ended,
      title: result === "none" ? STRINGS.thread.noResult : undefined,
      attention: result === "none",
    };
  }
  return null;
}

export function ConversationLibrary({
  active = true,
  agents,
  filter,
  onFilter,
  onOpen,
  onImport,
  onNew,
  defaultCwd,
  header,
}: {
  active?: boolean;
  agents: AgentCardModel[];
  filter: LibraryFilter;
  onFilter: (filter: LibraryFilter) => void;
  onOpen: (row: SidebarRow) => void;
  onImport: (opener: HTMLButtonElement) => void;
  onNew: () => void;
  defaultCwd: string | null;
  header?: ReactNode;
}) {
  const data = useCollections();
  const readState = useConversationReadState();
  const selection = normalizeLibraryFilter(filter);
  const { state: tab, query } = selection;
  const changeFilter = (patch: Partial<LibrarySelection>) =>
    onFilter({ kind: "selection", ...selection, ...patch });
  const setTab = (state: LibraryTab) => changeFilter({ state });
  const clearFilters = () =>
    changeFilter({ agent: "", group: "", query: "", state: "all" });
  const archived = tab === "archived";
  const allRows = useLibraryRows(archived);
  const snapshot = useThreadsSnapshot();
  const index = snapshot.index;
  const agentOptions = useMemo(() => {
    const historyAgents = new Set(index.map((row) => row.agentId));
    const names = new Map(
      agents
        .filter(
          (agent) =>
            isAgentPresentable(agent) ||
            historyAgents.has(agent.id) ||
            selection.agent === agent.id,
        )
        .map((agent) => [agent.id, agent.name || agent.id]),
    );
    for (const row of index)
      if (!names.has(row.agentId)) names.set(row.agentId, row.agentId);
    if (selection.agent && !names.has(selection.agent))
      names.set(selection.agent, selection.agent);
    return [...names].sort(
      ([leftId, leftName], [rightId, rightName]) =>
        leftName.localeCompare(rightName, "zh-CN") ||
        leftId.localeCompare(rightId),
    );
  }, [agents, index, selection.agent]);
  const archiveReasons = useArchiveBlockReasons(allRows.map((row) => row.key));
  const draftKeys = useSyncExternalStore(
    composerDrafts.subscribe,
    () =>
      allRows
        .filter((row) => composerDrafts.hasContent(`session:${row.key}`))
        .map((row) => row.key)
        .join("\n"),
    () =>
      allRows
        .filter((row) => composerDrafts.hasContent(`session:${row.key}`))
        .map((row) => row.key)
        .join("\n"),
  );
  const rowsWithDraft = new Set(draftKeys.split("\n"));
  const [organizing, setOrganizing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SidebarRow | null>(null);
  const [title, setTitle] = useState("");
  const [actions, setActions] = useState<SidebarRow | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const actionAnchor = useRef<HTMLButtonElement | null>(null);
  const moveAnchor = useRef<HTMLButtonElement | null>(null);
  const operation = useRef(new CollectionActionScope());
  useEffect(() => {
    if (!active) {
      operation.current.invalidate();
      setActions(null);
      setEditing(null);
      setMoving(null);
    }
  }, [active]);
  useEffect(() => {
    const scope = operation.current;
    return () => scope.invalidate();
  }, []);
  useEffect(() => {
    operation.current.invalidate();
    setSelected(new Set());
    setActions(null);
    setMoving(null);
  }, [filter]);
  useEffect(() => {
    if (
      data.ready &&
      selection.group &&
      selection.group !== "none" &&
      !data.groups.some((g) => g.id === selection.group)
    )
      changeFilter({ group: "" });
  }, [data.ready, data.groups, filter, onFilter]);
  const dimensions = selection;
  const rows = useMemo(
    () =>
      allRows.filter(
        (r) =>
          (!dimensions.favorites || r.pinned) &&
          (!dimensions.agent || r.agentId === dimensions.agent) &&
          (!dimensions.group ||
            (dimensions.group === "none"
              ? !data.assignments[r.key]
              : data.assignments[r.key] === dimensions.group)) &&
          (tab === "all" ||
            tab === "archived" ||
            (tab === "unread" ? r.unread : r.status === tab)) &&
          (!query.trim() ||
            `${r.title} ${r.cwd} ${agents.find((a) => a.id === r.agentId)?.name ?? r.agentId} ${data.groups.find((g) => g.id === data.assignments[r.key])?.name ?? ""}`
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase())),
      ),
    [
      allRows,
      dimensions.favorites,
      dimensions.agent,
      dimensions.group,
      data,
      agents,
      tab,
      query,
    ],
  );
  const visibleSelected = selectedLibraryRows(rows, selected);
  const actionRow = actions && allRows.find((row) => row.key === actions.key);
  const actionArchiveReason =
    !archived && actionRow && archiveReasons.get(actionRow.key);
  const blockedSelected = archived
    ? []
    : visibleSelected.filter((row) => archiveReasons.get(row.key));
  const allSelected = rows.length > 0 && visibleSelected.length === rows.length;
  const agentName = dimensions.agent
    ? (agents.find((a) => a.id === dimensions.agent)?.name ?? dimensions.agent)
    : "";
  const groupName =
    dimensions.group === "none"
      ? LIBRARY.noGroup
      : (data.groups.find((g) => g.id === dimensions.group)?.name ?? "");
  const heading =
    [dimensions.favorites ? LIBRARY.favorites : "", agentName, groupName]
      .filter(Boolean)
      .join(" · ") || LIBRARY.all;
  const filtered = Boolean(
    dimensions.favorites ||
    dimensions.agent ||
    dimensions.group ||
    query.trim() ||
    tab !== "all",
  );
  const perform = <T,>(work: () => Promise<T>, success?: (result: T) => void) =>
    operation.current.run(work, {
      pending: (value) => {
        setBusy(value);
        if (value) setError(null);
      },
      success,
      failure: (reason) => setError(uiError(reason, LIBRARY.error)),
    });
  const changeSelection = (update: (current: Set<string>) => Set<string>) => {
    operation.current.invalidate();
    setSelected(update);
  };
  const closeEditor = () => {
    operation.current.invalidate();
    setEditing(null);
  };
  const archiveRows = (targets: SidebarRow[]) =>
    perform(
      async () => {
        const results = await Promise.allSettled(
          targets.map((r) => threads.setArchived(r.key, !archived)),
        );
        return results.flatMap((result, i) =>
          result.status === "rejected"
            ? [{ row: targets[i], reason: result.reason as unknown }]
            : [],
        );
      },
      (failed) => {
        setSelected(new Set(failed.map(({ row }) => row.key)));
        if (failed.length)
          setError(
            [
              ...new Set(
                failed.map(({ reason }) => uiError(reason, LIBRARY.error)),
              ),
            ].join(" "),
          );
        else setActions(null);
      },
    );
  return (
    <main className="main library-page">
      <header className="library-contextbar">
        {header}
        <span>{LIBRARY.conversations}</span>
        <ResumeDraftButton onClick={onNew} />
      </header>
      <div className="library-scroll">
        <div className="library-heading">
          <div>
            <h1>{heading}</h1>
            <p>
              {LIBRARY.count(rows.length)}
              {dimensions.group && ` · ${LIBRARY.groupScopeHint}`}
            </p>
          </div>
          <div className="library-heading-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={(event) => onImport(event.currentTarget)}
            >
              {LIBRARY.import}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onNew}>
              <PlusIcon size={15} />
              {LIBRARY.newChat}
            </button>
          </div>
        </div>
        <div className="library-tools">
          <label className="library-search">
            <MagnifyingGlassIcon size={16} />
            <input
              aria-label={LIBRARY.query}
              placeholder={LIBRARY.query}
              value={query}
              onChange={(e) => changeFilter({ query: e.target.value })}
            />
          </label>
          <select
            aria-label={LIBRARY.allAgents}
            value={dimensions.agent}
            onChange={(e) => changeFilter({ agent: e.target.value })}
          >
            <option value="">{LIBRARY.allAgents}</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label={LIBRARY.allGroups}
            value={dimensions.group}
            disabled={!data.ready}
            onChange={(e) => changeFilter({ group: e.target.value })}
          >
            <option value="">{LIBRARY.allGroups}</option>
            <option value="none">{LIBRARY.noGroup}</option>
            {data.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-text library-organize"
            aria-pressed={organizing}
            onClick={() => {
              setOrganizing(!organizing);
              changeSelection(() => new Set());
            }}
          >
            {organizing ? LIBRARY.finishOrganizing : LIBRARY.organize}
          </button>
        </div>
        {filtered && (
          <div
            className="library-active-filters"
            aria-label={LIBRARY.currentFilters}
          >
            {dimensions.favorites && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => changeFilter({ favorites: false })}
              >
                {LIBRARY.favorites} ×
              </button>
            )}
            {dimensions.agent && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => changeFilter({ agent: "" })}
              >
                {agentName} ×
              </button>
            )}
            {dimensions.group && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => changeFilter({ group: "" })}
              >
                {groupName} ×
              </button>
            )}
            {query.trim() && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => changeFilter({ query: "" })}
              >
                {query} ×
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={clearFilters}
            >
              {LIBRARY.clearFilters}
            </button>
          </div>
        )}
        {readState.error && (
          <p className="ac-error" role="alert">
            {readState.error}
            <button
              className="btn btn-text"
              onClick={() =>
                void conversationReadState.flush().catch(() => undefined)
              }
            >
              {LIBRARY.retry}
            </button>
          </p>
        )}
        <div
          className="library-tabs"
          role="tablist"
          aria-label={LIBRARY.allStates}
        >
          {LIBRARY_TABS.map(([id, label], index) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls="conversation-library-results"
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % LIBRARY_TABS.length
                    : event.key === "ArrowLeft"
                      ? (index + LIBRARY_TABS.length - 1) % LIBRARY_TABS.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? LIBRARY_TABS.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setTab(LIBRARY_TABS[next][0]);
                event.currentTarget.parentElement
                  ?.querySelectorAll("button")
                  [next]?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {(error || data.error) && (
          <div className="auth-note" role="alert">
            {error ?? data.error}
            {!data.ready && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => void collections.load().catch(() => undefined)}
              >
                {LIBRARY.retry}
              </button>
            )}
          </div>
        )}
        {organizing && rows.length > 0 && (
          <div className="library-bulk">
            <label>
              <input
                type="checkbox"
                aria-label={LIBRARY.selectAll}
                checked={allSelected}
                onChange={() =>
                  changeSelection((previous) =>
                    toggleVisibleSelection(rows, previous),
                  )
                }
              />
              {LIBRARY.selected(visibleSelected.length)}
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                busy || !data.ready || data.saving || !visibleSelected.length
              }
              onClick={(event) => {
                operation.current.invalidate();
                setError(null);
                moveAnchor.current = event?.currentTarget ?? null;
                setMoving(visibleSelected.map((row) => row.key));
              }}
            >
              {LIBRARY.assign}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={
                busy || !visibleSelected.length || blockedSelected.length > 0
              }
              aria-describedby={
                blockedSelected.length
                  ? "library-bulk-archive-reason"
                  : undefined
              }
              onClick={() => void archiveRows(visibleSelected)}
            >
              {archived ? LIBRARY.restore : LIBRARY.archive}
            </button>
            {blockedSelected.length ? (
              <small id="library-bulk-archive-reason">
                {LIBRARY.archiveBlockedCount(blockedSelected.length)}{" "}
                {[
                  ...new Set(
                    blockedSelected.map(
                      (row) =>
                        LIBRARY.archiveReasons[archiveReasons.get(row.key)!],
                    ),
                  ),
                ].join(" ")}
              </small>
            ) : (
              <small>{LIBRARY.activePreserved}</small>
            )}
          </div>
        )}
        <div
          className="library-list"
          id="conversation-library-results"
          role="tabpanel"
          aria-label={LIBRARY_TABS.find(([id]) => id === tab)?.[1]}
        >
          {rows.map((row) => {
            const agentCard = agents.find((a) => a.id === row.agentId);
            const loaded = snapshot.threads.get(row.key);
            const result = row.status === "idle" ? loadedResult(loaded) : null;
            const viewOnly =
              loaded &&
              (loaded.modelDrift || loaded.sourceError) &&
              hasReadableMessages(loaded.items);
            return (
              <div className="library-row" key={row.key}>
                {organizing && (
                  <input
                    type="checkbox"
                    aria-label={row.title}
                    checked={selected.has(row.key)}
                    onChange={() =>
                      changeSelection((prev) => {
                        const next = new Set(prev);
                        if (next.has(row.key)) next.delete(row.key);
                        else next.add(row.key);
                        return next;
                      })
                    }
                  />
                )}
                <button
                  type="button"
                  className="library-row-open"
                  onClick={() => onOpen(row)}
                >
                  {agentCard ? (
                    <AgentLogo card={agentCard} />
                  ) : (
                    <ChatCircleIcon size={21} />
                  )}
                  <span>
                    <strong>{row.title}</strong>
                    <small>
                      {agentCard?.name ?? row.agentId} ·{" "}
                      {row.cwd === defaultCwd
                        ? LIBRARY.ordinary
                        : basename(row.cwd)}
                      {data.assignments[row.key]
                        ? ` · ${data.groups.find((g) => g.id === data.assignments[row.key])?.name ?? ""}`
                        : ""}
                    </small>
                  </span>
                </button>
                {row.status !== "idle" && (
                  <span className={`library-status ${row.status}`}>
                    {row.status === "need"
                      ? LIBRARY.attention
                      : LIBRARY.running}
                  </span>
                )}
                {result && (
                  <span
                    className={`library-status${result.attention ? " need" : ""}`}
                    title={result.title}
                  >
                    {result.label}
                  </span>
                )}
                {viewOnly && (
                  <span className="library-status">{LIBRARY.viewOnly}</span>
                )}
                {row.unread && (
                  <span className="library-status unread">
                    {LIBRARY.unread}
                  </span>
                )}
                {rowsWithDraft.has(row.key) && (
                  <span className="draft-badge">{LIBRARY.draft}</span>
                )}
                <time>{relativeTime(row.updatedAt)}</time>
                <button
                  type="button"
                  className={`icon-button library-star ${row.pinned ? "is-favorite" : ""}`}
                  disabled={busy}
                  aria-label={
                    row.pinned ? LIBRARY.unfavorite : LIBRARY.favorite
                  }
                  onClick={() =>
                    void perform(() => threads.setPinned(row.key, !row.pinned))
                  }
                >
                  <StarIcon
                    size={16}
                    weight={row.pinned ? "fill" : "regular"}
                  />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={LIBRARY.actions(row.title)}
                  aria-expanded={actions?.key === row.key}
                  aria-haspopup="dialog"
                  onClick={(event) => {
                    actionAnchor.current = event?.currentTarget ?? null;
                    operation.current.invalidate();
                    setError(null);
                    setActions(row);
                  }}
                >
                  <DotsThreeIcon size={19} />
                </button>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <div className="library-empty">
            <ChatCircleIcon size={32} />
            <h2>{filtered ? LIBRARY.noResults : LIBRARY.empty}</h2>
            <p>
              {tab === "archived"
                ? LIBRARY.archivedHint
                : filtered
                  ? LIBRARY.filteredHint
                  : LIBRARY.emptyHint}
            </p>
            {filtered && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={clearFilters}
              >
                {LIBRARY.clearFilters}
              </button>
            )}
          </div>
        )}
      </div>
      {active && actions && (
        <WorkspaceActionMenu
          anchor={actionAnchor.current}
          title={actions.title}
          onClose={() => {
            operation.current.invalidate();
            setActions(null);
          }}
        >
          <div className="workspace-action-body">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                operation.current.invalidate();
                setError(null);
                setEditing(actions);
                setTitle(actions.title);
                setActions(null);
              }}
            >
              {LIBRARY.rename}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !data.ready || data.saving}
              onClick={() => {
                operation.current.invalidate();
                setError(null);
                moveAnchor.current = actionAnchor.current;
                setMoving([actions.key]);
                setActions(null);
              }}
            >
              {LIBRARY.assign}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !actionRow || Boolean(actionArchiveReason)}
              aria-describedby={
                actionArchiveReason ? "library-archive-reason" : undefined
              }
              onClick={() => {
                if (actionRow) void archiveRows([actionRow]);
              }}
            >
              {archived ? LIBRARY.restore : LIBRARY.archive}
            </button>
            {actionArchiveReason && (
              <p className="archive-block-reason" id="library-archive-reason">
                {LIBRARY.archiveReasons[actionArchiveReason]}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </WorkspaceActionMenu>
      )}
      {active && moving && (
        <MoveConversationsDialog
          count={moving.length}
          returnFocusRef={moveAnchor}
          groups={data.groups}
          busy={busy || !data.ready || data.saving}
          error={error}
          onClose={() => {
            operation.current.invalidate();
            setMoving(null);
          }}
          onMove={(groupId) =>
            void perform(
              () => collections.assign(moving, groupId),
              () => setMoving(null),
            )
          }
        />
      )}
      {active && editing && (
        <WorkspaceDialog title={LIBRARY.rename} onClose={closeEditor}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim())
                void perform(
                  () => threads.rename(editing.key, title.trim()),
                  () => setEditing(null),
                );
            }}
          >
            <div className="workspace-dialog-body">
              <label>
                {LIBRARY.title}
                <input
                  autoFocus
                  value={title}
                  disabled={busy}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={closeEditor}
              >
                {LIBRARY.cancel}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || !title.trim()}
              >
                {LIBRARY.save}
              </button>
            </footer>
          </form>
        </WorkspaceDialog>
      )}
    </main>
  );
}
