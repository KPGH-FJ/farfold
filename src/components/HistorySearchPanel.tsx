import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AgentCardModel } from "../runtime/agents";
import {
  threads,
  type IndexRow,
  type SidebarRow,
  useThreadsSnapshot,
} from "../runtime/sessions";
import {
  historySearch,
  type HistorySearchController,
  type HistorySearchOwner,
} from "../runtime/history_search_controller";
import {
  validHistoryQuery,
  type HistorySearchHit,
} from "../runtime/history_search_types";
import { HISTORY_SEARCH_STRINGS as S } from "../runtime/history_search_strings";
import { STRINGS } from "../runtime/strings";
import {
  HistorySearchResults,
  HistorySearchText,
} from "./HistorySearchResults";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "./HistorySearchPanel.css";

export function HistorySearchPanel({
  active,
  agents,
  agentOwners,
  rows,
  query,
  scopeKey = "",
  onOpen,
  controller = historySearch,
}: {
  active: boolean;
  agents: AgentCardModel[];
  agentOwners?: ReadonlyMap<string, object>;
  rows: SidebarRow[];
  query: string;
  scopeKey?: string;
  onOpen(row: SidebarRow): void;
  controller?: HistorySearchController;
}) {
  const snapshot = useThreadsSnapshot();
  const [agentId, setAgentId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<HistorySearchHit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef({ active, rows, agentOwners, query, scopeKey });
  live.current = { active, rows, agentOwners, query, scopeKey };
  const mounted = useRef(false);
  const activeOwner = useRef<HistorySearchOwner | null>(null);
  const chosenIds = [...selected];
  const selectionKey = JSON.stringify(chosenIds);
  const selectedRows = chosenIds.map((id) =>
    snapshot.index.find((row) => row.id === id),
  );
  const capturedRows = useRef({ key: selectionKey, rows: selectedRows });
  if (
    capturedRows.current.key !== selectionKey ||
    selectedRows.some((row, i) => row !== capturedRows.current.rows[i])
  )
    capturedRows.current = { key: selectionKey, rows: selectedRows };
  const captured = capturedRows.current.rows;
  const agentOwner = agentOwners?.get(agentId);
  const owner = useMemo((): HistorySearchOwner => {
    let retired = false;
    const authority: HistorySearchOwner = {
      agentId,
      current() {
        if (retired) return false;
        const current = live.current,
          state = threads.getSnapshot();
        const valid =
          mounted.current &&
          activeOwner.current === authority &&
          current.active &&
          current.query === query &&
          current.scopeKey === scopeKey &&
          current.agentOwners?.get(agentId) === agentOwner &&
          captured.every(
            (row) =>
              row &&
              state.index.find((r) => r.id === row.id) === row &&
              !state.threads.has(row.id) &&
              current.rows.some((r) => r.key === row.id),
          );
        if (!valid) retired = true;
        return valid;
      },
    };
    return authority;
    // Equal values after any view/scope/program change must receive a new owner.
  }, [agentId, agentOwner, selectionKey, scopeKey, query, active, captured]);
  activeOwner.current = owner;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.retire(owner);
    };
  }, [controller, owner]);
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!active || !owner.current()) controller.retire(owner);
    return () => controller.retire(owner);
  }, [active, controller, owner]);
  useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  useEffect(() => {
    if (!owner.current()) controller.retire(owner);
  });
  const view = controller.get(agentId);
  const flight = view.flight;
  const visibleOperation =
    flight?.owner === owner && owner.current() ? flight.operation : null;
  useEffect(() => {
    if (
      !active ||
      !flight ||
      flight.unconfirmed ||
      flight.admissionClosed ||
      flight.operation?.settled
    )
      return;
    const timer = setInterval(
      () => controller.check(agentId, flight.expected.requestId),
      1000,
    );
    return () => clearInterval(timer);
  }, [
    active,
    agentId,
    controller,
    flight,
    flight?.admissionClosed,
    flight?.unconfirmed,
    flight?.operation?.settled,
  ]);
  const candidateRows = rows.filter((r) => r.agentId === agentId);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  for (const row of rows)
    if (!names.has(row.agentId)) names.set(row.agentId, row.agentId);
  const title = (id: string) =>
    rows.find((r) => r.key === id)?.title || STRINGS.sessions.untitled;
  const canRead = (row: SidebarRow) => {
    const indexed = snapshot.index.find((r) => r.id === row.key);
    return Boolean(indexed?.nativeSessionId && !snapshot.threads.has(row.key));
  };
  const select = (id: string, checked: boolean) => {
    controller.retire(owner);
    setSelected((old) => {
      const next = new Set(old);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const chooseAgent = (id: string) => {
    controller.retire(owner);
    setAgentId(id);
    setSelected(new Set());
    setPreview(null);
  };
  const choosePreview = (hit: HistorySearchHit) => {
    if (
      active &&
      owner.current() &&
      flight?.owner === owner &&
      flight.operation?.hits.includes(hit)
    )
      setPreview(hit);
  };
  const openOriginal = () => {
    if (
      !preview ||
      !active ||
      !owner.current() ||
      flight?.owner !== owner ||
      !flight.operation?.hits.includes(preview)
    ) {
      setError(S.stale);
      return;
    }
    const row = live.current.rows.find((r) => r.key === preview.rowId);
    const indexed = threads
      .getSnapshot()
      .index.find((r: IndexRow) => r.id === preview.rowId);
    if (!row || !indexed || indexed.agentId !== agentId) {
      setError(S.sourceMissing);
      return;
    }
    setPreview(null);
    controller.retire(owner);
    onOpen(row);
  };
  const stateLabel = !flight
    ? null
    : flight.admissionClosed
      ? S.closed
      : flight.unconfirmed
        ? S.unconfirmed
        : flight.operation?.settled
          ? flight.operation.state === "completed"
            ? S.complete
            : flight.operation.state === "cancelled"
              ? S.cancelled
              : S.failed
          : flight.operation?.state === "pendingCleanup"
            ? S.cleanup
            : flight.cancelRequested
              ? S.cancelling
              : S.reading;
  const previewCurrent =
    preview && visibleOperation?.hits.includes(preview) ? preview : null;
  return (
    <section className="history-search-panel" aria-label={S.title}>
      <h2>{S.title}</h2>
      {controller
        .trackedAgents()
        .filter((id) => id !== agentId)
        .map((id) => (
          <button
            key={id}
            type="button"
            className="btn btn-ghost"
            onClick={() => chooseAgent(id)}
          >
            {S.track(names.get(id) ?? id)}
          </button>
        ))}
      <p>{S.officialStartup}</p>
      <p>{S.limit}</p>
      <label className="history-search-agent">
        {S.chooseAgent}
        <select value={agentId} onChange={(e) => chooseAgent(e.target.value)}>
          <option value="">{S.chooseAgent}</option>
          {[...names].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {agentId && (
        <fieldset disabled={Boolean(flight)}>
          <legend>
            {S.chooseConversations} · {S.selected(selected.size)}
          </legend>
          {!candidateRows.length && <p>{S.noCandidates}</p>}
          <div className="history-search-candidates">
            {candidateRows.map((row) => (
              <label key={row.key}>
                <input
                  type="checkbox"
                  checked={selected.has(row.key)}
                  disabled={
                    !canRead(row) ||
                    (!selected.has(row.key) && selected.size >= 20)
                  }
                  onChange={(e) => select(row.key, e.target.checked)}
                />
                <span>
                  {row.title || STRINGS.sessions.untitled}
                  <small>
                    {!canRead(row)
                      ? snapshot.threads.has(row.key)
                        ? S.errors.alreadyOpen
                        : S.errors.noNativeHistory
                      : row.cwd}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {!flight && (
        <div className="history-search-actions">
          <button
            className="btn btn-ghost"
            type="button"
            disabled={!active || !agentId || !selected.size || view.preparing}
            onClick={() => {
              setError(null);
              void controller.prepare(owner, chosenIds);
            }}
          >
            {view.preparing ? S.preparing : S.prepare}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={
              !active ||
              view.selection?.availability !== "available" ||
              !validHistoryQuery(query)
            }
            onClick={() => controller.start(owner, query)}
          >
            {S.start}
          </button>
          {query && !validHistoryQuery(query) && <p>{S.queryInvalid}</p>}
        </div>
      )}
      {view.error && <p role="status">{S.errors[view.error]}</p>}
      {view.selection?.availability === "unavailable" && (
        <ul>
          {view.selection.rows
            .filter((r) => r.code)
            .map((r) => (
              <li key={r.rowId}>
                {title(r.rowId)} · {S.errors[r.code!]}
              </li>
            ))}
        </ul>
      )}
      {flight && (
        <>
          <p role="status">{stateLabel}</p>
          {flight.owner !== owner &&
            !flight.admissionClosed &&
            !flight.operation?.settled && <p>{S.retained}</p>}
          {flight.error && <p>{S.errors[flight.error]}</p>}
          <div className="history-search-actions">
            {!flight.admissionClosed && !flight.operation?.settled && (
              <>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={flight.checking}
                  onClick={() =>
                    controller.check(agentId, flight.expected.requestId)
                  }
                >
                  {flight.checking ? S.checking : S.check}
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={flight.cancelling}
                  onClick={() =>
                    controller.cancel(agentId, flight.expected.requestId)
                  }
                >
                  {S.cancel}
                </button>
              </>
            )}
            {(flight.admissionClosed || flight.operation?.settled) && (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={flight.releasing}
                onClick={() => {
                  void controller
                    .dismiss(agentId, flight.expected.requestId)
                    .then((ok) => {
                      if (
                        !ok &&
                        live.current.active &&
                        controller.get(agentId).flight === flight
                      )
                        setError(S.releaseFailed);
                    });
                }}
              >
                {S.dismiss}
              </button>
            )}
          </div>
          {visibleOperation && (
            <HistorySearchResults
              operation={visibleOperation}
              title={title}
              onPreview={choosePreview}
            />
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {active && previewCurrent && (
        <WorkspaceDialog title={S.preview} onClose={() => setPreview(null)}>
          <p>{S.previewScope}</p>
          <h3>{title(previewCurrent.rowId)}</h3>
          <HistorySearchText hit={previewCurrent} />
          {previewCurrent.textTruncated && <p>{S.truncated}</p>}
          {previewCurrent.matchesTruncated && <p>{S.matchesTruncated}</p>}
          <p>{S.openScope}</p>
          <button
            className="btn btn-primary"
            type="button"
            onClick={openOriginal}
          >
            {S.openConversation}
          </button>
        </WorkspaceDialog>
      )}
    </section>
  );
}
