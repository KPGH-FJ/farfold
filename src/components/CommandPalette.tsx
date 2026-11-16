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
import { useModalDialog, wrapModalTab } from "./useModalDialog";
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

function metadataMatchRank(
  query: string,
  fields: [title: string, ...otherFields: string[]],
): number | null {
  if (!query) return 0;
  const normalized = fields.map((field) => field.toLowerCase());
  if (normalized[0] === query) return 0;
  if (normalized.includes(query)) return 1;
  if (normalized.some((field) => field.includes(query))) return 2;

  // Keep cross-field subsequence matches below direct matches in a field.
  const combined = normalized.join(" ");
  if (combined.includes(query)) return 3;
  let matched = 0;
  for (const ch of combined) {
    if (ch === query[matched]) matched += 1;
    if (matched === query.length) return 3;
  }
  return null;
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

  const entries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return snapshot.index
      .flatMap((row) => {
        const agent = agents.find((card) => card.id === row.agentId);
        const agentName = agent?.name ?? row.agentId;
        const group = collections.groups.find(
          (item) => item.id === collections.assignments[row.id],
        )?.name;
        const rank = metadataMatchRank(normalizedQuery, [
          row.title ?? "",
          row.cwd,
          agentName,
          group ?? "",
        ]);
        return rank === null ? [] : [{ row, agent, agentName, group, rank }];
      })
      .sort((a, b) => a.rank - b.rank || b.row.updatedAt - a.row.updatedAt);
  }, [snapshot.index, agents, collections, query]);

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
        wrapModalTab(event);
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
