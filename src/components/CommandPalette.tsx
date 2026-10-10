/** Global conversation search; only admitted index entries are searchable. */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChatCircleIcon, XIcon } from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import {
  useThreadsSnapshot,
  type IndexRow,
  type SidebarRow,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { useCollections } from "../runtime/collections";
import { LIBRARY } from "../runtime/library_strings";
import { AgentLogo } from "./AgentLogo";
import { useModalDialog } from "./useModalDialog";
import "../command-palette.css";
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
import { LOADED_SEARCH_STRINGS as S } from "../runtime/loaded_search_strings";

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
  onSelect,
  returnFocusRef,
  onSelectLoaded,
}: {
  agents: AgentCardModel[];
  onClose: () => void;
  onSelect: (row: IndexRow | SidebarRow) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onSelectLoaded?: SelectLoadedSearch;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"metadata" | "body">("metadata");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const titleId = useId();
  const snapshot = useThreadsSnapshot();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const collections = useCollections();
  const searchKeys = snapshot.index.map((row) => row.id);
  const body = useLoadedSearch(
    searchKeys,
    snapshot.threads,
    query,
    snapshot.version,
    scope === "body",
  );
  const hits = body.result?.hits ?? [];
  const current = useRef({
    snapshot,
    searchKeys,
    query,
    scope,
    hits,
    onSelectLoaded,
  });
  current.current = {
    snapshot,
    searchKeys,
    query,
    scope,
    hits,
    onSelectLoaded,
  };
  const chooseBody = (hit: LoadedSearchHit) => {
    const accepts = () => {
      const now = current.current;
      return (
        mounted.current &&
        now.scope === "body" &&
        now.query.trim() === hit.query &&
        now.hits.includes(hit) &&
        loadedSearchHitIsCurrent(hit, now.snapshot.threads, now.searchKeys)
      );
    };
    if (!accepts()) {
      setSearchError(S.stale);
      return;
    }
    current.current.onSelectLoaded?.(hit, accepts);
  };
  const { onCancel, onClick } = useModalDialog({
    dialogRef,
    onDismiss: onClose,
    returnFocusRef,
    initialFocusRef: inputRef,
    backdropDismiss: true,
  });

  const entries = useMemo(
    () =>
      [...snapshot.index]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((row) => {
          const agent = agents.find((card) => card.id === row.agentId);
          const agentName = agent?.name ?? row.agentId;
          const group = collections.groups.find(
            (item) => item.id === collections.assignments[row.id],
          )?.name;
          return { row, agent, agentName, group };
        })
        .filter(({ row, agentName, group }) =>
          fuzzyMatch(
            query,
            `${row.title ?? ""} ${row.cwd} ${agentName} ${group ?? ""}`,
          ),
        ),
    [snapshot.index, agents, collections, query],
  );

  const count = scope === "body" ? hits.length : entries.length;
  useEffect(() => {
    setSel(0);
    setSearchError(null);
  }, [query, scope]);
  useEffect(
    () => setSel((value) => Math.max(0, Math.min(value, count - 1))),
    [count],
  );
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, entries, hits]);
  const choose = (row: IndexRow) => {
    onClose();
    onSelect(row);
  };
  const onKey = (event: React.KeyboardEvent) => {
    // WebKit may clear isComposing before the confirming key reports 229.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSel((value) => Math.max(0, Math.min(count - 1, value + 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSel((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (scope === "body") {
        if (hits[sel]) chooseBody(hits[sel]);
      } else if (entries[sel]) choose(entries[sel].row);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="command-palette-dialog"
      aria-labelledby={titleId}
      onCancel={onCancel}
      onKeyDown={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "k"
        ) {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={onClick}
    >
      <header className="conversation-search-title">
        <h2 id={titleId}>{STRINGS.palette.title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={STRINGS.palette.close}
          onClick={onClose}
        >
          <XIcon size={18} />
        </button>
      </header>
      <div className="conversation-search-body">
        <label>
          {S.scope}{" "}
          <select
            aria-label={S.scope}
            value={scope}
            onChange={(event) =>
              setScope(event.target.value === "body" ? "body" : "metadata")
            }
          >
            <option value="metadata">{S.metadata}</option>
            <option value="body">{S.body}</option>
          </select>
        </label>
        <input
          ref={inputRef}
          className="conversation-search-input"
          role="combobox"
          aria-label={scope === "body" ? S.query : STRINGS.palette.searchLabel}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={sel < count ? `${listId}-${sel}` : undefined}
          placeholder={scope === "body" ? S.query : STRINGS.palette.placeholder}
          maxLength={scope === "body" ? 512 : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKey}
        />
        {scope === "body" && <LoadedSearchSummary {...body} query={query} />}
        {searchError && <p role="alert">{searchError}</p>}
        <div
          className="conversation-search-results"
          id={listId}
          role="listbox"
          ref={listRef}
        >
          {scope === "body" ? (
            <LoadedSearchResults
              hits={hits}
              selected={sel}
              onSelect={setSel}
              onChoose={chooseBody}
              id={listId}
              title={(key) =>
                snapshot.index.find((row) => row.id === key)?.title ||
                STRINGS.sessions.untitled
              }
            />
          ) : (
            <>
              {entries.length === 0 && (
                <p role="status">{STRINGS.palette.empty}</p>
              )}
              {entries.map(({ row, agent, agentName, group }, index) => (
                <button
                  key={row.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === sel}
                  onMouseEnter={() => setSel(index)}
                  onClick={() => choose(row)}
                >
                  {agent ? (
                    <AgentLogo card={agent} />
                  ) : (
                    <ChatCircleIcon size={19} />
                  )}
                  <span>
                    <strong>{row.title || STRINGS.sessions.untitled}</strong>
                    <small>
                      {agentName} · {group || LIBRARY.noGroup}
                      {row.archived
                        ? ` · ${STRINGS.palette.groupArchived}`
                        : ""}
                    </small>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
        <p className="conversation-search-hint">
          {scope === "body" ? S.keyboard : STRINGS.palette.hint}
        </p>
      </div>
    </dialog>
  );
}
