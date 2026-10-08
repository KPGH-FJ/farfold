import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ChatCircleTextIcon,
  CheckIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import { threads, type IndexRow } from "../runtime/sessions";
import {
  closeHistoryPreview,
  commitHistoryPreview,
  discoverHistory,
  hasPreviewContent,
  historyContinuation,
  previewHistory,
  type DiscoveredConversation,
  type HistoryPreview,
} from "../runtime/history_import";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import { LIBRARY } from "../runtime/library_strings";
import { MessageContent } from "./MessageContent";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { AgentLogo } from "./AgentLogo";
import { chooseDirectory } from "../runtime/dialogs";
import { observeAuthentication } from "../runtime/authentication";
import {
  configValueLabel,
  modelConfigOption,
} from "../runtime/session_projection";

interface LookupDraft {
  rows: DiscoveredConversation[];
  cursor: string | null;
  searched: boolean;
  choosing: boolean;
  unsupported: boolean;
  query: string;
  selected: Set<string>;
  previewId: string | null;
  added: Record<string, IndexRow>;
  failed: Set<string>;
}

export async function importConversationBatch(
  rows: DiscoveredConversation[],
  actions: {
    save: (row: DiscoveredConversation) => Promise<IndexRow | null>;
    release: () => Promise<void>;
    onAdded: (nativeSessionId: string, saved: IndexRow) => void;
  },
) {
  const failures: string[] = [];
  let count = 0;
  let cleanupFailed = false;
  for (const [index, row] of rows.entries()) {
    let committed = false;
    try {
      const saved = await actions.save(row);
      if (!saved) break;
      committed = true;
      actions.onAdded(row.nativeSessionId, saved);
      count++;
      await actions.release();
    } catch {
      // Releasing a preview cannot undo a confirmed index write.
      if (!committed) failures.push(row.nativeSessionId);
      try {
        await actions.release();
      } catch {
        cleanupFailed = true;
        failures.push(
          ...rows.slice(index + 1).map((item) => item.nativeSessionId),
        );
        break;
      }
    }
  }
  return { count, failures, cleanupFailed };
}

export function ImportConversations({
  agents,
  open,
  initialAgentId = null,
  requestRevision = 0,
  defaultCwd,
  onClose,
  onOpen,
  onPrepare,
  onNew,
  returnFocusRef,
}: {
  agents: AgentCardModel[];
  open: boolean;
  initialAgentId?: string | null;
  requestRevision?: number;
  defaultCwd?: string | null;
  onClose: () => void;
  onOpen: (row: IndexRow) => void;
  onPrepare?: (agentId: string | undefined, cwd: string | null) => void;
  onNew?: (agentId: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const available = agents.filter(
    (a) => a.status === "installed" || a.status === "connected",
  );
  const [agentId, setAgentId] = useState(
    initialAgentId ?? available[0]?.id ?? "",
  );
  const [lookupCwd, setLookupCwd] = useState<string | null>(null);
  const lookupRevision = useRef(0);
  const requestedContext = `${requestRevision}\0${initialAgentId ?? ""}`;
  const requestedContextRef = useRef(requestedContext);
  requestedContextRef.current = requestedContext;
  const [rows, setRows] = useState<DiscoveredConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [choosing, setChoosing] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<HistoryPreview | null>(null);
  const previewRef = useRef<HistoryPreview | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const openRef = useRef(open);
  openRef.current = open;
  const [error, setError] = useState<string | null>(null);
  const [preparationCwd, setPreparationCwd] = useState<
    { cwd: string | null } | undefined
  >();
  const [message, setMessage] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, IndexRow>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const lookupDrafts = useRef(new Map<string, LookupDraft>());
  const agentLocations = useRef(new Map<string, string | null>());
  useEffect(() => {
    lookupDrafts.current.set(JSON.stringify([agentId, lookupCwd]), {
      rows,
      cursor,
      searched,
      choosing,
      unsupported,
      query,
      selected,
      previewId,
      added,
      failed,
    });
    agentLocations.current.set(agentId, lookupCwd);
  }, [
    agentId,
    lookupCwd,
    rows,
    cursor,
    searched,
    choosing,
    unsupported,
    query,
    selected,
    previewId,
    added,
    failed,
  ]);
  const restoreDiscovery = (nextAgent: string, nextCwd: string | null) => {
    lookupRevision.current++;
    const saved = lookupDrafts.current.get(
      JSON.stringify([nextAgent, nextCwd]),
    );
    setAgentId(nextAgent);
    setLookupCwd(nextCwd);
    setRows(saved?.rows ?? []);
    setSearched(saved?.searched ?? false);
    setChoosing(!saved?.searched);
    setUnsupported(saved?.unsupported ?? false);
    setQuery(saved?.query ?? "");
    setCursor(saved?.cursor ?? null);
    setPreviewId(saved?.previewId ?? null);
    setSelected(new Set(saved?.selected));
    setAdded(saved?.added ?? {});
    setFailed(new Set(saved?.failed));
    setError(null);
    setPreparationCwd(undefined);
    setMessage(null);
  };
  const currentLookup = (revision: number, context: string) =>
    mounted.current &&
    lookupRevision.current === revision &&
    requestedContextRef.current === context;
  useEffect(() => {
    if (!agentId && available.length) setAgentId(available[0].id);
  }, [agentId, available]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const p = previewRef.current;
      if (p) void closeHistoryPreview(p).catch(() => undefined);
    };
  }, []);
  const visible = rows.filter((r) =>
    `${r.title ?? ""} ${r.cwd}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const canAdd = (r: DiscoveredConversation) =>
    r.canLoad &&
    r.locationAvailable &&
    !r.alreadyAddedId &&
    !r.isOpen &&
    !added[r.nativeSessionId];
  const selectable = visible.filter(canAdd);
  const selectedRows = rows.filter(
    (r) => canAdd(r) && selected.has(r.nativeSessionId),
  );
  const allSelected =
    selectable.length > 0 &&
    selectable.every((row) => selected.has(row.nativeSessionId));
  const hiddenSelected = selectedRows.filter(
    (row) => !visible.includes(row),
  ).length;
  const release = async () => {
    const p = previewRef.current;
    if (!p) return;
    try {
      await closeHistoryPreview(p);
    } catch {
      throw new Error(S.cleanupFailed);
    }
    if (previewRef.current !== p) return;
    previewRef.current = null;
    if (mounted.current) setPreview(null);
  };
  const work = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    const revision = lookupRevision.current;
    const context = requestedContextRef.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setPreparationCwd(undefined);
    setMessage(null);
    try {
      await fn();
    } catch (reason) {
      if (currentLookup(revision, context))
        setError(reason instanceof Error ? reason.message : S.loadFailed);
    } finally {
      if (!openRef.current) {
        try {
          await release();
        } catch {
          if (mounted.current) setError(S.cleanupFailed);
        }
      }
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) void work(release);
  }, [open]);
  const handledRequest = useRef(-1);
  useEffect(() => {
    if (
      !open ||
      busy ||
      handledRequest.current === requestRevision ||
      !initialAgentId
    )
      return;
    if (!available.some((card) => card.id === initialAgentId)) return;
    handledRequest.current = requestRevision;
    if (agentId === initialAgentId) return;
    void work(async () => {
      await release();
      restoreDiscovery(
        initialAgentId,
        agentLocations.current.get(initialAgentId) ?? null,
      );
    });
  }, [open, busy, initialAgentId, requestRevision]);
  const close = () => {
    openRef.current = false;
    onClose();
  };
  const preparationFailure = (reason: unknown, cwd: string | null) => {
    if (String(reason).replace(/^Error:\s*/, "") !== "AUTH_REQUIRED")
      return false;
    const effectiveCwd = cwd ?? defaultCwd;
    if (effectiveCwd) observeAuthentication(agentId, effectiveCwd, reason);
    setPreparationCwd({ cwd });
    return true;
  };
  const selectedAgent = agents.find((card) => card.id === agentId);
  const needsPreparation =
    !available.length ||
    (selectedAgent && selectedAgent.status !== "connected") ||
    preparationCwd !== undefined;
  const prepare = () => {
    if (!onPrepare || !needsPreparation) return;
    const target = selectedAgent?.id;
    const cwd = preparationCwd?.cwd ?? lookupCwd;
    const revision = lookupRevision.current;
    const context = requestedContextRef.current;
    void work(async () => {
      await release();
      if (!openRef.current || !currentLookup(revision, context)) return;
      openRef.current = false;
      onPrepare(target, cwd);
    });
  };
  const discover = (more = false) =>
    work(async () => {
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      await release();
      if (!currentLookup(revision, context)) return;
      setPreviewId(null);
      setListing(true);
      const page = await discoverHistory(
        agentId,
        more ? (cursor ?? undefined) : undefined,
        lookupCwd,
      )
        .catch((reason) => {
          if (!currentLookup(revision, context)) return null;
          throw new Error(
            preparationFailure(reason, lookupCwd)
              ? S.authRequired
              : S.listFailed,
          );
        })
        .finally(() => setListing(false));
      if (!page || !currentLookup(revision, context)) return;
      const merged = new Map<string, DiscoveredConversation>();
      for (const row of [...(more ? rows : []), ...page.sessions])
        merged.set(row.nativeSessionId, row);
      const nextRows = [...merged.values()];
      setRows(nextRows);
      const retainEligible = (previous: Set<string>) =>
        new Set(
          nextRows
            .filter((row) => canAdd(row) && previous.has(row.nativeSessionId))
            .map((row) => row.nativeSessionId),
        );
      setSelected(retainEligible);
      setFailed(retainEligible);
      setCursor(
        page.nextCursor && (!more || page.nextCursor !== cursor)
          ? page.nextCursor
          : null,
      );
      setSearched(true);
      setChoosing(false);
      setUnsupported(page.status === "unsupported");
    });
  const view = (row: DiscoveredConversation) =>
    work(async () => {
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      await release();
      if (!currentLookup(revision, context)) return;
      setPreviewId(row.nativeSessionId);
      if (row.alreadyAddedId || added[row.nativeSessionId]) return;
      if (!row.locationAvailable) throw new Error(S.locationHint);
      if (!row.canLoad) throw new Error(S.noLoad);
      if (row.isOpen) throw new Error(S.busy);
      const loaded = await previewHistory(agentId, row).catch((reason) => {
        if (!currentLookup(revision, context)) return null;
        throw new Error(
          preparationFailure(reason, row.cwd)
            ? S.authRequired
            : reason instanceof Error && reason.message === S.noContent
              ? S.noContent
              : S.loadFailed,
        );
      });
      if (!loaded) return;
      if (!mounted.current) {
        await closeHistoryPreview(loaded);
        return;
      }
      previewRef.current = loaded;
      if (!currentLookup(revision, context)) {
        await release();
        return;
      }
      setPreview(loaded);
      if (!loaded.replayComplete) throw new Error(S.loadFailed);
      if (!hasPreviewContent(loaded)) throw new Error(S.noContent);
    });
  const add = (targets = selectedRows) =>
    work(async () => {
      const eligible = targets.filter(canAdd);
      const completed = new Set<string>();
      const { count, failures, cleanupFailed } = await importConversationBatch(
        eligible,
        {
          save: async (row) => {
            let current = previewRef.current;
            if (!current || current.nativeSessionId !== row.nativeSessionId) {
              await release();
              current = await previewHistory(agentId, row);
              previewRef.current = current;
            }
            if (!mounted.current) {
              await release();
              return null;
            }
            return commitHistoryPreview(current, row.title);
          },
          release,
          onAdded: (nativeSessionId, saved) => {
            completed.add(nativeSessionId);
            setAdded((old) => ({ ...old, [nativeSessionId]: saved }));
          },
        },
      );
      setSelected(
        (previous) =>
          new Set([
            ...[...previous].filter((id) => !completed.has(id)),
            ...failures,
          ]),
      );
      setFailed(
        (previous) =>
          new Set([
            ...[...previous].filter(
              (id) => !eligible.some((row) => row.nativeSessionId === id),
            ),
            ...failures,
          ]),
      );
      setMessage(count > 0 ? S.addedCount(count) : null);
      if (cleanupFailed) setError(S.cleanupFailed);
      else if (failures.length) setError(S.addFailed);
      try {
        await threads.refreshIndex();
      } catch {
        throw new Error(S.refreshFailed);
      }
    });
  const openExisting = (row: DiscoveredConversation) =>
    work(async () => {
      const found =
        added[row.nativeSessionId] ??
        threads.getSnapshot().index.find((r) => r.id === row.alreadyAddedId);
      if (!found) throw new Error(S.busy);
      await release();
      close();
      onOpen(found);
    });
  const previewRow = visible.find((r) => r.nativeSessionId === previewId);
  // Exactly three user-visible results: joined, nothing to join, or an
  // incomplete/uncertain outcome whose technical detail stays collapsed.
  const failedRows = rows.filter((r) => failed.has(r.nativeSessionId));
  const outcome =
    error || failed.size
      ? "incomplete"
      : message
        ? "imported"
        : searched && !listing && !choosing && (unsupported || !visible.length)
          ? "none"
          : null;
  const chooseAgent = (nextAgent: string) => {
    if (nextAgent === agentId) {
      if (searched) setChoosing(false);
      return;
    }
    void work(async () => {
      await release();
      restoreDiscovery(
        nextAgent,
        agentLocations.current.get(nextAgent) ?? null,
      );
    });
  };
  const changeLocation = (useDefault = false) =>
    work(async () => {
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      const next = useDefault
        ? null
        : await chooseDirectory(lookupCwd ?? undefined);
      if (
        (!useDefault && !next) ||
        !openRef.current ||
        !currentLookup(revision, context) ||
        next === lookupCwd
      )
        return;
      await release();
      if (!openRef.current || !currentLookup(revision, context)) return;
      restoreDiscovery(agentId, next);
    });
  const startNew = () => {
    if (!onNew || !agentId) return;
    const revision = lookupRevision.current;
    const context = requestedContextRef.current;
    void work(async () => {
      await release();
      if (!openRef.current || !currentLookup(revision, context)) return;
      close();
      onNew(agentId);
    });
  };
  const step = listing ? 1 : choosing ? 0 : 2;
  return open ? (
    <WorkspaceDialog
      title={S.title}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <div className="history-import">
        <ol className="history-steps" aria-label={S.stepsLabel}>
          {S.steps.map((label, index) => (
            <li
              key={label}
              className={step > index ? "complete" : undefined}
              aria-current={step === index ? "step" : undefined}
            >
              <span>{step > index ? <CheckIcon size={12} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <details className="history-location history-hint">
          <summary>
            {S.location} · {lookupCwd ?? S.defaultScope}
          </summary>
          <p title={lookupCwd ?? undefined}>{lookupCwd ?? S.defaultScope}</p>
          <p>{lookupCwd ? S.selectedScopeHint : S.defaultScopeHint}</p>
          <div className="history-search">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void changeLocation()}
            >
              {S.chooseLocation}
            </button>
            {lookupCwd && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void changeLocation(true)}
              >
                {S.resetScope}
              </button>
            )}
          </div>
        </details>
        {choosing && !listing ? (
          <>
            <h3>{S.chooseHeading}</h3>
            <p className="history-hint">{S.preserveHint}</p>
            <div className="history-agent-grid">
              {available.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  aria-pressed={agentId === card.id}
                  disabled={busy}
                  onClick={() => chooseAgent(card.id)}
                >
                  <AgentLogo card={card} />
                  <span>
                    <strong>{card.name}</strong>
                    <small>
                      {card.status === "connected" ? S.connected : S.installed}
                    </small>
                  </span>
                  {agentId === card.id && (
                    <CheckCircleIcon
                      className="history-agent-check"
                      size={18}
                    />
                  )}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="history-source-row">
              <div>
                {selectedAgent && <AgentLogo card={selectedAgent} />}
                <strong>{selectedAgent?.name}</strong>
                <span>{S.existingConversations}</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await release();
                    setChoosing(true);
                  })
                }
              >
                {S.changeAgent}
              </button>
            </div>
            <p className="history-hint">{S.hint}</p>
          </>
        )}
        {!available.length && (
          <div className="history-empty">
            <ChatCircleTextIcon size={27} />
            <strong>{S.noAgentsTitle}</strong>
            <p>{S.noAgents}</p>
            {onPrepare && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={prepare}
              >
                {S.addAgent}
              </button>
            )}
          </div>
        )}
        {outcome === "incomplete" && (
          <div className="history-outcome partial" role="alert">
            <WarningCircleIcon size={20} />
            <div>
              <strong>{S.operationIncomplete}</strong>
              {message && <p>{message}</p>}
              {!!failed.size && <p>{S.partialHint}</p>}
              <details className="history-outcome-details">
                <summary>{S.outcomeDetails}</summary>
                {error && <p>{error}</p>}
                {!!failedRows.length && (
                  <ul>
                    {failedRows.map((row) => (
                      <li key={row.nativeSessionId}>
                        {row.title ?? S.unknownTitle}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </div>
          </div>
        )}
        {onPrepare && needsPreparation && available.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={prepare}
          >
            {S.prepareAgent}
          </button>
        )}
        {outcome === "imported" && (
          <div className="history-outcome" role="status">
            <CheckCircleIcon size={20} />
            <div>
              <strong>{message}</strong>
              <p>{S.joinedHint}</p>
            </div>
          </div>
        )}
        {listing && (
          <div className="history-empty" role="status">
            <CircleNotchIcon className="spin" size={25} />
            <strong>{S.searching}</strong>
            <p>{S.searchingHint}</p>
          </div>
        )}
        {!choosing && !listing && searched && (
          <div className="history-search">
            <input
              aria-label={S.query}
              placeholder={S.query}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !agentId}
              onClick={() => void discover()}
            >
              {S.again}
            </button>
          </div>
        )}
        {!choosing &&
          !listing &&
          (outcome === "none" ? (
            <div className="history-empty">
              <ChatCircleTextIcon size={27} />
              <strong>
                {unsupported
                  ? S.unsupportedTitle
                  : query.trim()
                    ? S.noMatches
                    : S.empty}
              </strong>
              <p>
                {unsupported
                  ? S.unsupported
                  : query.trim()
                    ? S.queryHint
                    : S.emptyHint}
              </p>
              {unsupported && onNew && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy || !agentId}
                  onClick={startNew}
                >
                  {S.newChat}
                </button>
              )}
              {!unsupported && !!query.trim() && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setQuery("")}
                >
                  {S.clearQuery}
                </button>
              )}
            </div>
          ) : (
            <div className="history-columns">
              <div className="history-results">
                {selectable.length > 0 && (
                  <label className="history-select-all">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={allSelected}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          selectable.forEach((r) =>
                            allSelected
                              ? next.delete(r.nativeSessionId)
                              : next.add(r.nativeSessionId),
                          );
                          return next;
                        })
                      }
                    />
                    {S.all}
                  </label>
                )}
                {visible.map((row) => (
                  <div
                    className={`history-row ${previewId === row.nativeSessionId ? "active" : ""}`}
                    key={row.nativeSessionId}
                  >
                    <input
                      type="checkbox"
                      aria-label={row.title ?? S.unknownTitle}
                      disabled={busy || !canAdd(row)}
                      checked={selected.has(row.nativeSessionId)}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.nativeSessionId))
                            next.delete(row.nativeSessionId);
                          else next.add(row.nativeSessionId);
                          return next;
                        })
                      }
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void view(row)}
                    >
                      <strong>{row.title ?? S.unknownTitle}</strong>
                      <small>
                        {row.alreadyAddedId || added[row.nativeSessionId]
                          ? S.added
                          : !row.locationAvailable
                            ? S.locationMissing
                            : !row.canLoad
                              ? S.noLoad
                              : row.isOpen
                                ? S.busy
                                : row.cwd === defaultCwd
                                  ? LIBRARY.ordinary
                                  : row.cwd}
                      </small>
                    </button>
                    {failed.has(row.nativeSessionId) && canAdd(row) && (
                      <div className="history-row-failure">
                        <small>{S.rowFailed}</small>
                        <button
                          type="button"
                          className="btn btn-text"
                          disabled={busy}
                          onClick={() => void add([row])}
                        >
                          {S.retryRow}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="history-preview">
                <h3>{S.preview}</h3>
                {previewRow ? (
                  <>
                    <h4>{previewRow.title ?? S.unknownTitle}</h4>
                    {previewRow.alreadyAddedId ||
                    added[previewRow.nativeSessionId] ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => openExisting(previewRow)}
                      >
                        {S.open}
                      </button>
                    ) : preview &&
                      preview.nativeSessionId === previewRow.nativeSessionId ? (
                      preview.replayComplete ? (
                        <>
                          <div className="history-continuation" role="note">
                            <strong>
                              {historyContinuation(preview).title}
                            </strong>
                            <p>{historyContinuation(preview).detail}</p>
                            <dl>
                              <dt>{S.currentModel}</dt>
                              <dd>
                                {configValueLabel(
                                  modelConfigOption(
                                    preview.state.configOptions,
                                  ),
                                ) || S.notProvided}
                              </dd>
                              <dt>{S.source}</dt>
                              <dd>
                                {preview.state.service
                                  ? S.savedService
                                  : S.agentSettings}
                              </dd>
                              <dt>{S.conversationLocation}</dt>
                              <dd>
                                {preview.cwd === defaultCwd
                                  ? LIBRARY.ordinary
                                  : preview.cwd}
                              </dd>
                            </dl>
                          </div>
                          {!hasPreviewContent(preview) && <p>{S.noContent}</p>}
                          {preview.state.items.map((item) =>
                            item.kind === "user" || item.kind === "agent" ? (
                              <div
                                className={`history-message ${item.kind}`}
                                key={item.id}
                              >
                                <small>
                                  {item.kind === "user" ? S.you : S.agentRole}
                                </small>
                                <MessageContent
                                  source={item}
                                  text={item.text}
                                  attachments={item.attachments}
                                />
                              </div>
                            ) : null,
                          )}
                        </>
                      ) : (
                        <p>{S.loadFailed}</p>
                      )
                    ) : (
                      <p>{busy ? S.working : S.previewHint}</p>
                    )}
                  </>
                ) : (
                  <p>{S.previewHint}</p>
                )}
              </div>
            </div>
          ))}
        {!choosing && searched && !unsupported && cursor && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void discover(true)}
          >
            {S.more}
          </button>
        )}
      </div>
      <footer>
        <span className="history-close-hint">
          {busy
            ? S.closeHint
            : choosing
              ? S.keepHint
              : `${S.selected(selectedRows.length)}${hiddenSelected ? S.selectedHidden(hiddenSelected) : ""}`}
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => setSelected(new Set())}
          >
            {S.clearSelection}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={close}>
          {S.cancel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            busy ||
            (choosing ? !agentId || !available.length : !selectedRows.length)
          }
          onClick={() => void (choosing ? discover() : add())}
        >
          {busy
            ? S.working
            : choosing
              ? S.search
              : selectedRows.length > 0 &&
                  selectedRows.every((row) => failed.has(row.nativeSessionId))
                ? S.retrySelected
                : S.add}
        </button>
      </footer>
    </WorkspaceDialog>
  ) : null;
}
