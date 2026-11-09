import { SelectedAttachmentSearch } from "./SelectedAttachmentSearch";
import type { SelectAttachmentSearch } from "../runtime/attachment_search_source";
import { ATTACHMENT_SEARCH_STRINGS as ATTACHMENT_SEARCH } from "../runtime/attachment_search_strings";
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
import { ConversationExportHost } from "./ConversationExportHost";
import {
  captureConversationExport,
  releasedExportSnapshot,
  type ConversationExportSnapshot,
} from "../runtime/conversation_archive_snapshot";
import { ARCHIVE_STRINGS } from "../runtime/conversation_archive_strings";
import { fileDelivery } from "../runtime/file_delivery";
import { exportFileName } from "../runtime/conversation_actions";
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
import { maintenanceLabel } from "../runtime/compaction_strings";
import { hasReadableMessages } from "../runtime/message_attachments";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceActionMenu } from "./WorkspaceActionMenu";
import { AgentLogo } from "./AgentLogo";
import { composerDrafts, hasUnsentWork } from "../runtime/drafts";
import { ResumeDraftButton } from "./ResumeDraftButton";
import { MoveConversationsDialog } from "./MoveConversationsDialog";
import { DeleteConversationsDialog } from "./DeleteConversationsDialog";
import {
  conversationReadState,
  useConversationReadState,
} from "../runtime/conversation_read_state";

import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
import {
  LoadedSearchResults,
  LoadedSearchSummary,
} from "./LoadedSearchResults";
import { useLoadedSearch } from "./useLoadedSearch";
import {
  loadedSearchHitIsCurrent,
  type LoadedSearchHit,
  type SelectLoadedSearch,
} from "../runtime/loaded_search";
import { LOADED_SEARCH_STRINGS as SEARCH } from "../runtime/loaded_search_strings";
import "../settings-library-redesign.css";
import { HistorySearchPanel } from "./HistorySearchPanel";
import { HISTORY_SEARCH_STRINGS as HISTORY } from "../runtime/history_search_strings";

const LIBRARY_TABS = [
  ["all", LIBRARY.allTab],
  ["drafts", R.unsent],
  ["need", LIBRARY.attention],
  ["run", LIBRARY.running],
  ["unread", LIBRARY.unread],
  ["archived", LIBRARY.archived],
] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number][0];
export type LibraryReturnFocus = { opener: HTMLButtonElement };

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
        maintenanceLabel(result) ??
        (result === "reply"
          ? STRINGS.thread.done
          : result === "none"
            ? LIBRARY.noResult
            : result === "pending"
              ? LIBRARY.running
              : STRINGS.thread.ended),
      title: result === "none" ? STRINGS.thread.noResult : undefined,
      attention:
        result === "none" ||
        result === "maintenance_failed" ||
        result === "maintenance_unknown",
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
  returnFocus,
  onImport,
  onNew,
  onReopen,
  defaultCwd,
  header,
  onSelectLoaded,
  onSelectAttachment,
  agentOwners,
}: {
  active?: boolean;
  agentOwners?: ReadonlyMap<string, object>;
  agents: AgentCardModel[];
  filter: LibraryFilter;
  onFilter: (filter: LibraryFilter) => void;
  onOpen: (row: SidebarRow, opener?: HTMLButtonElement) => void;
  returnFocus?: LibraryReturnFocus;
  onImport: (opener: HTMLButtonElement) => void;
  onNew: () => void;
  /** W3-9：用相同 Agent 与设置再开一段对话。 */
  onReopen?: (row: SidebarRow) => void;
  defaultCwd: string | null;
  header?: ReactNode;
  onSelectLoaded?: SelectLoadedSearch;
  onSelectAttachment?: SelectAttachmentSearch;
}) {
  const data = useCollections();
  const readState = useConversationReadState();
  const selection = normalizeLibraryFilter(filter);
  const { state: tab, query } = selection;
  const selectedTab = useRef<HTMLButtonElement>(null);
  const restoredFocus = useRef<LibraryReturnFocus | null>(null);
  useEffect(() => {
    if (!active || !returnFocus || restoredFocus.current === returnFocus)
      return;
    restoredFocus.current = returnFocus;
    const { opener } = returnFocus;
    // Reading an unread conversation can remove its row from this filter.
    (opener.isConnected && !opener.disabled
      ? opener
      : selectedTab.current
    )?.focus();
  }, [active, returnFocus]);
  const changeFilter = (patch: Partial<LibrarySelection>) =>
    onFilter({ kind: "selection", ...selection, ...patch });
  const setTab = (state: LibraryTab) => changeFilter({ state });
  const clearFilters = () =>
    changeFilter({ agent: "", group: "", query: "", state: "all" });
  const archived = tab === "archived";
  const allRows = useLibraryRows(archived);
  // Keep tab counts aligned with the same protected archive projection.
  const otherRows = useLibraryRows(!archived);
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
      [...allRows, ...otherRows]
        .filter((row) => hasUnsentWork(row.key))
        .map((row) => row.key)
        .join("\n"),
    () =>
      [...allRows, ...otherRows]
        .filter((row) => hasUnsentWork(row.key))
        .map((row) => row.key)
        .join("\n"),
  );
  const rowsWithDraft = new Set(draftKeys.split("\n"));
  const [organizing, setOrganizing] = useState(false);
  const [searchScope, setSearchScope] = useState<
    "metadata" | "body" | "history" | "attachments"
  >("metadata");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SidebarRow | null>(null);
  const [title, setTitle] = useState("");
  const [exported, setExported] = useState<{
    capture: ConversationExportSnapshot;
    name: string;
  } | null>(null);
  const [actions, setActions] = useState<SidebarRow | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<SidebarRow[] | null>(null);
  const [clearing, setClearing] = useState<SidebarRow[] | null>(null);
  const actionAnchor = useRef<HTMLButtonElement | null>(null);
  const moveAnchor = useRef<HTMLButtonElement | null>(null);
  const deleteAnchor = useRef<HTMLElement | null>(null);
  const operation = useRef(new CollectionActionScope());
  useEffect(() => {
    if (!active) {
      operation.current.invalidate();
      setExported(null);
      setActions(null);
      setEditing(null);
      setMoving(null);
      setDeleting(null);
      setClearing(null);
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
    setDeleting(null);
    setClearing(null);
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
            (tab === "drafts"
              ? rowsWithDraft.has(r.key) ||
                Boolean(snapshot.threads.get(r.key)?.queued.length)
              : tab === "unread"
                ? r.unread
                : r.status === tab)) &&
          (searchScope !== "metadata" ||
            !query.trim() ||
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
      searchScope,
      draftKeys,
      snapshot.threads,
    ],
  );
  const archivedRows = rows.filter((row) => row.archived);
  const archivedKeys = new Set(
    (archived ? allRows : otherRows).map((row) => row.key),
  );
  const stateCounts = new Map(LIBRARY_TABS.map(([id]) => [id, 0]));
  for (const row of [...allRows, ...otherRows]) {
    const matches =
      (!dimensions.favorites || row.pinned) &&
      (!dimensions.agent || row.agentId === dimensions.agent) &&
      (!dimensions.group ||
        (dimensions.group === "none"
          ? !data.assignments[row.key]
          : data.assignments[row.key] === dimensions.group)) &&
      (searchScope !== "metadata" ||
        !query.trim() ||
        `${row.title} ${row.cwd} ${agents.find((a) => a.id === row.agentId)?.name ?? row.agentId} ${data.groups.find((g) => g.id === data.assignments[row.key])?.name ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()));
    if (!matches) continue;
    const increment = (id: LibraryTab) =>
      stateCounts.set(id, (stateCounts.get(id) ?? 0) + 1);
    if (archivedKeys.has(row.key)) {
      increment("archived");
      continue;
    }
    increment("all");
    if (hasUnsentWork(row.key) || snapshot.threads.get(row.key)?.queued.length)
      increment("drafts");
    if (row.unread) increment("unread");
    if (row.status === "need" || row.status === "run") increment(row.status);
  }
  const visibleSelected = selectedLibraryRows(rows, selected);
  const searchKeys = rows.map((row) => row.key);
  const bodySearch = useLoadedSearch(
    searchKeys,
    snapshot.threads,
    query,
    snapshot.version,
    active && searchScope === "body",
  );
  const searchNow = useRef({
    active,
    searchScope,
    query,
    searchKeys,
    bodySearch,
    onSelectLoaded,
  });
  const searchMounted = useRef(true);
  useEffect(() => {
    searchMounted.current = true;
    return () => {
      searchMounted.current = false;
    };
  }, []);
  searchNow.current = {
    active,
    searchScope,
    query,
    searchKeys,
    bodySearch,
    onSelectLoaded,
  };
  const chooseSearch = (hit: LoadedSearchHit) => {
    const accepts = () => {
      const now = searchNow.current;
      return (
        searchMounted.current &&
        now.active &&
        now.searchScope === "body" &&
        now.query.trim() === hit.query &&
        !!now.bodySearch.result?.hits.includes(hit) &&
        loadedSearchHitIsCurrent(
          hit,
          threads.getSnapshot().threads,
          now.searchKeys,
        )
      );
    };
    if (!accepts()) {
      setError(SEARCH.stale);
      return;
    }
    searchNow.current.onSelectLoaded?.(hit, accepts);
  };
  const actionRow = actions && allRows.find((row) => row.key === actions.key);
  const actionArchiveReason =
    !archived && actionRow && archiveReasons.get(actionRow.key);
  const actionDeleteReason = actionRow && archiveReasons.get(actionRow.key);
  const blockedSelected = archived
    ? []
    : visibleSelected.filter((row) => archiveReasons.get(row.key));
  // W3-9：删除与归档共用同一套活跃度门禁——进行中或未确认的对话先完成
  // 或清除待办，避免删除后活动工作与索引失联。
  const deleteBlocked = visibleSelected.filter((row) =>
    archiveReasons.get(row.key),
  );
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
  // W3-9：删除（单个/批量/清空归档共用确认）、导出、位置显示、相同设置再开。
  const deleteRows = (targets: SidebarRow[]) =>
    perform(
      async () => {
        for (const row of targets) {
          const reason = threads.archiveBlockReason(row.key);
          if (reason) throw new Error(LIBRARY.deleteReasons[reason]);
          if (
            clearing &&
            !threads.getSnapshot().index.find((item) => item.id === row.key)
              ?.archived
          )
            throw new Error(R.archivedChanged);
        }
        const outcomes = await Promise.allSettled(
          targets.map((row) => threads.delete(row)),
        );
        const removed = targets
          .filter((_, index) => outcomes[index].status === "fulfilled")
          .map((row) => row.key);
        if (removed.length)
          await collections.assign(removed, "").catch(() => undefined);
        return outcomes;
      },
      (outcomes) => {
        const failed = targets.filter(
          (_, i) => outcomes[i].status === "rejected",
        );
        const notices = new Set<string>();
        let notRequested = 0;
        let agentUnknown = 0;
        for (const outcome of outcomes) {
          if (outcome.status === "rejected")
            notices.add(uiError(outcome.reason, LIBRARY.deleteLocalUnknown));
          else if (outcome.value === "unsupported") notRequested++;
          else if (outcome.value === "unconfirmed") agentUnknown++;
        }
        if (notRequested)
          notices.add(LIBRARY.deleteNotRequestedCount(notRequested));
        if (agentUnknown)
          notices.add(LIBRARY.deleteAgentUnknownCount(agentUnknown));
        setSelected(new Set(failed.map((row) => row.key)));
        setDeleting(null);
        setClearing(null);
        setActions(null);
        setError([...notices].join(" ") || null);
      },
    );
  const exportRow = (row: SidebarRow) => {
    const loaded = snapshot.threads.get(row.key);
    if (!loaded) {
      setError(LIBRARY.exportNotLoaded);
      return;
    }
    try {
      setExported({
        capture: captureConversationExport(
          loaded,
          row.title,
          agents.find((a) => a.id === row.agentId)?.name ?? row.agentId,
        ),
        name: exportFileName(row.title),
      });
      setActions(null);
    } catch (e) {
      setError(
        e && typeof e === "object" && "code" in e && e.code === "empty"
          ? LIBRARY.exportEmpty
          : ARCHIVE_STRINGS.errors.tooLarge,
      );
    }
  };
  const revealLocation = (row: SidebarRow) =>
    perform(
      () => fileDelivery.revealLocation(row.cwd),
      () => setActions(null),
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
        <p className="library-search-boundary">
          {searchScope === "attachments"
            ? ATTACHMENT_SEARCH.boundary
            : searchScope === "history"
              ? HISTORY.boundary
              : searchScope === "body"
                ? SEARCH.boundary
                : R.searchBoundary}
        </p>
        <div className="library-tools">
          <select
            aria-label={SEARCH.scope}
            value={searchScope}
            onChange={(event) => {
              setSearchScope(
                event.target.value === "attachments"
                  ? "attachments"
                  : event.target.value === "history"
                    ? "history"
                    : event.target.value === "body"
                      ? "body"
                      : "metadata",
              );
              setOrganizing(false);
              changeSelection(() => new Set());
            }}
          >
            <option value="metadata">{SEARCH.metadata}</option>
            <option value="body">{SEARCH.body}</option>
            <option value="history">{HISTORY.scope}</option>
            <option value="attachments">{ATTACHMENT_SEARCH.scope}</option>
          </select>
          <label className="library-search">
            <MagnifyingGlassIcon size={16} />
            <input
              aria-label={
                searchScope === "attachments"
                  ? ATTACHMENT_SEARCH.query
                  : searchScope === "history"
                    ? HISTORY.query
                    : searchScope === "body"
                      ? SEARCH.query
                      : LIBRARY.query
              }
              placeholder={
                searchScope === "attachments"
                  ? ATTACHMENT_SEARCH.query
                  : searchScope === "history"
                    ? HISTORY.query
                    : searchScope === "body"
                      ? SEARCH.query
                      : LIBRARY.query
              }
              maxLength={searchScope === "body" ? 512 : undefined}
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
            disabled={searchScope !== "metadata"}
            aria-pressed={organizing}
            onClick={() => {
              setOrganizing(!organizing);
              changeSelection(() => new Set());
            }}
          >
            {organizing ? LIBRARY.finishOrganizing : LIBRARY.organize}
          </button>
          {archived && archivedRows.length > 0 && (
            <button
              type="button"
              className="btn btn-text"
              disabled={busy}
              onClick={(event) => {
                operation.current.invalidate();
                setError(null);
                deleteAnchor.current = event.currentTarget;
                setClearing([...archivedRows]);
              }}
            >
              {LIBRARY.clearArchived}
            </button>
          )}
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
              ref={tab === id ? selectedTab : undefined}
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
              <span className="library-tab-count">
                {stateCounts.get(id) ?? 0}
              </span>
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
        {organizing && searchScope === "metadata" && rows.length > 0 && (
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
            <button
              className="btn btn-ghost"
              type="button"
              disabled={
                busy || !visibleSelected.length || deleteBlocked.length > 0
              }
              aria-describedby={
                deleteBlocked.length ? "library-bulk-delete-reason" : undefined
              }
              onClick={(event) => {
                operation.current.invalidate();
                setError(null);
                deleteAnchor.current = event.currentTarget;
                setDeleting(visibleSelected);
              }}
            >
              {LIBRARY.deleteSelected}
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
            {deleteBlocked.length > 0 && (
              <small id="library-bulk-delete-reason">
                {LIBRARY.deleteBlockedCount(deleteBlocked.length)}{" "}
                {[
                  ...new Set(
                    deleteBlocked.map(
                      (row) =>
                        LIBRARY.deleteReasons[archiveReasons.get(row.key)!],
                    ),
                  ),
                ].join(" ")}
              </small>
            )}
          </div>
        )}
        <div
          className={`library-list${searchScope === "body" ? " loaded-search-library" : ""}`}
          id="conversation-library-results"
          role="tabpanel"
          aria-label={LIBRARY_TABS.find(([id]) => id === tab)?.[1]}
        >
          {searchScope === "attachments" ? (
            <SelectedAttachmentSearch
              active={active}
              rows={rows}
              query={query}
              scopeKey={JSON.stringify([
                tab,
                dimensions.agent,
                dimensions.group,
                dimensions.favorites,
              ])}
              onSelect={onSelectAttachment}
            />
          ) : searchScope === "history" ? (
            <HistorySearchPanel
              scopeKey={JSON.stringify([
                tab,
                dimensions.agent,
                dimensions.group,
                dimensions.favorites,
              ])}
              active={active}
              agents={agents}
              agentOwners={agentOwners}
              rows={rows}
              query={query}
              onOpen={onOpen}
            />
          ) : searchScope === "body" ? (
            <>
              <LoadedSearchSummary {...bodySearch} query={query} />
              <LoadedSearchResults
                hits={bodySearch.result?.hits ?? []}
                onChoose={chooseSearch}
                title={(key) =>
                  rows.find((row) => row.key === key)?.title ||
                  STRINGS.sessions.untitled
                }
              />
            </>
          ) : (
            rows.map((row) => {
              const agentCard = agents.find((a) => a.id === row.agentId);
              const loaded = snapshot.threads.get(row.key);
              const result =
                row.status === "idle" ? loadedResult(loaded) : null;
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
                    onClick={(event) => onOpen(row, event.currentTarget)}
                  >
                    {agentCard ? (
                      <AgentLogo card={agentCard} />
                    ) : (
                      <ChatCircleIcon size={21} />
                    )}
                    <span>
                      <strong>{row.title}</strong>
                      <small title={row.cwd}>
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
                      {row.toolTailUnconfirmed
                        ? STRINGS.thread.unknown
                        : row.status === "need"
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
                  {!!loaded?.queued.length && (
                    <span className="draft-badge">
                      {R.queued(loaded.queued.length)}
                    </span>
                  )}
                  {row.archived && (
                    <span className="library-status">{LIBRARY.archived}</span>
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
                      void perform(() =>
                        threads.setPinned(row.key, !row.pinned),
                      )
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
            })
          )}
        </div>
        {rows.length === 0 && (
          <div className="library-empty">
            <ChatCircleIcon size={32} />
            <h2>
              {dimensions.favorites &&
              !query &&
              !dimensions.agent &&
              !dimensions.group
                ? R.favoritesEmpty
                : filtered
                  ? LIBRARY.noResults
                  : LIBRARY.empty}
            </h2>
            <p>
              {dimensions.favorites &&
              !query &&
              !dimensions.agent &&
              !dimensions.group
                ? R.favoritesHint
                : tab === "archived"
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
            {actionRow && snapshot.threads.has(actionRow.key) && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void exportRow(actionRow)}
              >
                {LIBRARY.exportMarkdown}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !actionRow?.cwd}
              onClick={() => {
                if (actionRow) void revealLocation(actionRow);
              }}
            >
              {LIBRARY.revealLocation}
            </button>
            {onReopen && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || !actionRow}
                onClick={() => {
                  const row = actionRow;
                  if (!row) return;
                  setActions(null);
                  onReopen(row);
                }}
              >
                {LIBRARY.reopenSame}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !actionRow || Boolean(actionDeleteReason)}
              aria-describedby={
                actionDeleteReason ? "library-row-delete-reason" : undefined
              }
              onClick={() => {
                if (!actionRow) return;
                operation.current.invalidate();
                setError(null);
                deleteAnchor.current = actionAnchor.current;
                setDeleting([actionRow]);
                setActions(null);
              }}
            >
              {LIBRARY.deleteAction}
            </button>
            {actionDeleteReason && (
              <p
                className="archive-block-reason"
                id="library-row-delete-reason"
              >
                {LIBRARY.deleteReasons[actionDeleteReason]}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </WorkspaceActionMenu>
      )}
      {active && moving && (
        <MoveConversationsDialog
          count={moving.length}
          rows={allRows
            .filter((row) => moving.includes(row.key))
            .map((row) => ({
              title: row.title,
              groupId: data.assignments[row.key] ?? "",
            }))}
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
      {active && deleting && (
        <DeleteConversationsDialog
          title={LIBRARY.deleteTitle(deleting.length)}
          targets={deleting.map((row) => row.title)}
          hint={
            deleting.length === 1
              ? LIBRARY.deleteHintOne(deleting[0].title)
              : LIBRARY.deleteHint
          }
          busy={busy}
          error={error}
          returnFocusRef={deleteAnchor}
          onClose={() => {
            operation.current.invalidate();
            setDeleting(null);
          }}
          onDelete={() => void deleteRows(deleting)}
        />
      )}
      {active && clearing && (
        <DeleteConversationsDialog
          title={LIBRARY.clearArchivedTitle}
          hint={R.archivedScope(clearing.length)}
          targets={clearing.map((row) => row.title)}
          busy={busy}
          error={error}
          returnFocusRef={deleteAnchor}
          onClose={() => {
            operation.current.invalidate();
            setClearing(null);
          }}
          onDelete={() => void deleteRows(clearing)}
        />
      )}
      {active && editing && (
        <WorkspaceDialog
          title={LIBRARY.rename}
          busy={busy}
          onClose={closeEditor}
        >
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
      {active && exported && (
        <ConversationExportHost
          {...exported}
          onRegistered={() =>
            setExported((current) =>
              current
                ? {
                    ...current,
                    capture: releasedExportSnapshot(current.capture),
                  }
                : null,
            )
          }
          returnFocusRef={actionAnchor}
          onClose={() => setExported(null)}
        />
      )}
    </main>
  );
}
