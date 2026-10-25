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
  readHistoryPreview,
  type DiscoveredConversation,
  type HistoryPreview,
} from "../runtime/history_import";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
import "../settings-library-redesign.css";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import { LIBRARY } from "../runtime/library_strings";
import { MessageContent } from "./MessageContent";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { HistoryReadStatus } from "./HistoryReadStatus";
import { AgentLogo } from "./AgentLogo";
import { chooseDirectory } from "../runtime/dialogs";
import {
  observeAuthentication,
  subscribeAuthenticationChanges,
} from "../runtime/authentication";
import { subscribeCredentialChanges } from "../runtime/credentials";
import {
  historyPreviewAgentKey,
  historyPreviewAssociationKey,
  historyPreviewRowKey,
} from "../runtime/history_preview_scope";
import {
  configValueLabel,
  modelConfigOption,
} from "../runtime/session_projection";

interface AddedConversation {
  saved: IndexRow;
  index: readonly IndexRow[];
}

interface PreviewInterest {
  agentId: string;
  inquirySignal: AbortSignal;
  inquiryCurrent: () => boolean;
  retire: () => void;
}

interface LookupDraft {
  rows: DiscoveredConversation[];
  cursor: string | null;
  searched: boolean;
  choosing: boolean;
  unsupported: boolean;
  query: string;
  selected: Set<string>;
  previewId: string | null;
  added: Record<string, AddedConversation>;
  failed: Set<string>;
}

function resolveAddedConversation(
  row: DiscoveredConversation,
  agentId: string,
  index: readonly IndexRow[],
  byId: ReadonlyMap<string, IndexRow>,
  added: Readonly<Record<string, AddedConversation>>,
) {
  const committed = added[row.nativeSessionId];
  const id = row.alreadyAddedId ?? committed?.saved.id;
  if (!id) return null;
  // A save receipt bridges only the snapshot before its first index refresh.
  // Later snapshots must never resurrect a row removed from the current index.
  const saved =
    byId.get(id) ??
    (committed?.saved.id === id && committed.index === index
      ? committed.saved
      : null);
  return saved?.agentId === agentId &&
    saved.nativeSessionId === row.nativeSessionId
    ? saved
    : null;
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
  index = threads.getSnapshot().index,
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
  index?: readonly IndexRow[];
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
  const [agentQuery, setAgentQuery] = useState("");
  const visibleAgents = available.filter((card) =>
    card.name
      .toLocaleLowerCase()
      .includes(agentQuery.trim().toLocaleLowerCase()),
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
  const [receivedPreview, setPreview] = useState<HistoryPreview | null>(null);
  const previewRef = useRef<HistoryPreview | null>(null);
  const previewInterest = useRef<PreviewInterest | null>(null);
  const pendingImports = useRef(new Set<PreviewInterest>());
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
  const [added, setAdded] = useState<Record<string, AddedConversation>>({});
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
  const selectedAgent = agents.find((card) => card.id === agentId);
  const viewKey = JSON.stringify([
    requestedContext,
    open,
    agentId,
    lookupCwd,
    query,
    historyPreviewAgentKey(selectedAgent),
  ]);
  const viewScope = useRef({ key: viewKey });
  if (viewScope.current.key !== viewKey) viewScope.current = { key: viewKey };
  const latestView = useRef({ rows, agentId, lookupCwd });
  latestView.current = { rows, agentId, lookupCwd };
  const createPreviewInterest = (
    row: DiscoveredConversation,
  ): PreviewInterest => {
    const scope = viewScope.current;
    const revision = lookupRevision.current;
    const context = requestedContextRef.current;
    const rowKey = historyPreviewRowKey(row);
    const association = historyPreviewAssociationKey(
      threads.getSnapshot().index,
      agentId,
      row.nativeSessionId,
    );
    const controller = new AbortController();
    let active = true;
    return {
      agentId,
      inquirySignal: controller.signal,
      retire: () => {
        active = false;
        controller.abort();
      },
      inquiryCurrent: () => {
        if (!active) return false;
        try {
          const currentRow = latestView.current.rows.find(
            (item) => item.nativeSessionId === row.nativeSessionId,
          );
          active =
            !controller.signal.aborted &&
            openRef.current &&
            currentLookup(revision, context) &&
            viewScope.current === scope &&
            latestView.current.agentId === agentId &&
            !!currentRow &&
            historyPreviewRowKey(currentRow) === rowKey &&
            historyPreviewAssociationKey(
              threads.getSnapshot().index,
              agentId,
              row.nativeSessionId,
            ) === association;
        } catch {
          active = false;
        }
        return active;
      },
    };
  };
  const previewCurrent = previewInterest.current?.inquiryCurrent() ?? false;
  for (const owner of pendingImports.current) owner.inquiryCurrent();
  const preview = previewCurrent ? receivedPreview : null;
  useEffect(() => {
    const owner = previewInterest.current;
    if (owner && !owner.inquiryCurrent()) owner.retire();
    for (const pending of pendingImports.current)
      if (!pending.inquiryCurrent()) pending.retire();
  }, [viewKey, rows, index]);
  useEffect(() => {
    const retire = (agent?: string) => {
      const owner = previewInterest.current;
      if (owner && (!agent || owner.agentId === agent)) {
        owner.retire();
        if (mounted.current) setPreview(null);
      }
      for (const pending of pendingImports.current)
        if (!agent || pending.agentId === agent) pending.retire();
    };
    const checkIndex = () => {
      const owner = previewInterest.current;
      if (owner && !owner.inquiryCurrent()) {
        owner.retire();
        if (mounted.current) setPreview(null);
      }
      for (const pending of pendingImports.current)
        if (!pending.inquiryCurrent()) pending.retire();
    };
    const stopIndex = threads.subscribe?.(checkIndex);
    const stopAuthentication = subscribeAuthenticationChanges(retire);
    const stopCredentials = subscribeCredentialChanges(() => retire());
    return () => {
      stopIndex?.();
      stopAuthentication();
      stopCredentials();
      previewInterest.current?.retire();
      for (const pending of pendingImports.current) pending.retire();
    };
  }, []);
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
  const savedById = new Map(index.map((row) => [row.id, row]));
  const joinedRow = (row: DiscoveredConversation) =>
    resolveAddedConversation(row, agentId, index, savedById, added);
  const visible = rows.filter((row) => {
    const saved = joinedRow(row);
    return `${row.title ?? ""} ${row.cwd} ${saved?.title ?? ""} ${saved?.cwd ?? ""}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  });
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
    const owner = previewInterest.current;
    owner?.retire();
    const p = previewRef.current;
    if (!p) return;
    try {
      await closeHistoryPreview(p);
    } catch {
      throw new Error(S.cleanupFailed);
    }
    if (previewRef.current !== p) return;
    previewRef.current = null;
    if (previewInterest.current === owner) previewInterest.current = null;
    if (mounted.current) setPreview(null);
  };
  const work = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    const revision = lookupRevision.current;
    const context = requestedContextRef.current;
    const scope = viewScope.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setPreparationCwd(undefined);
    setMessage(null);
    try {
      await fn();
    } catch (reason) {
      if (currentLookup(revision, context) && viewScope.current === scope)
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
      const context = requestedContextRef.current;
      const revision = lookupRevision.current;
      const scope = viewScope.current;
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
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
    const scope = viewScope.current;
    void work(async () => {
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
      openRef.current = false;
      onPrepare(target, cwd);
    });
  };
  const discover = (more = false) =>
    work(async () => {
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      const scope = viewScope.current;
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
      setPreviewId(null);
      setListing(true);
      const page = await discoverHistory(
        agentId,
        more ? (cursor ?? undefined) : undefined,
        lookupCwd,
      )
        .catch((reason) => {
          if (!currentLookup(revision, context) || viewScope.current !== scope)
            return null;
          throw new Error(
            preparationFailure(reason, lookupCwd)
              ? S.authRequired
              : S.listFailed,
          );
        })
        .finally(() => setListing(false));
      if (
        !page ||
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
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
      const scope = viewScope.current;
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
      setPreviewId(row.nativeSessionId);
      if (row.alreadyAddedId || added[row.nativeSessionId]) return;
      if (!row.locationAvailable) throw new Error(S.locationHint);
      if (!row.canLoad) throw new Error(S.noLoad);
      if (row.isOpen) throw new Error(S.busy);
      const owner = createPreviewInterest(row);
      if (!owner.inquiryCurrent()) return;
      previewInterest.current = owner;
      const loaded = await readHistoryPreview(agentId, row, owner).catch(
        (reason) => {
          if (!owner.inquiryCurrent()) return null;
          throw new Error(
            preparationFailure(reason, row.cwd)
              ? S.authRequired
              : reason instanceof Error && reason.message === S.noContent
                ? S.noContent
                : S.loadFailed,
          );
        },
      );
      if (!loaded) return;
      previewRef.current = loaded;
      if (!owner.inquiryCurrent()) {
        await release();
        return;
      }
      setPreview(loaded);
      if (!loaded.replayComplete) throw new Error(S.loadFailed);
      if (!hasPreviewContent(loaded)) throw new Error(S.noContent);
    });
  const add = (targets = selectedRows) =>
    work(async () => {
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      const scope = viewScope.current;
      const eligible = targets.filter(canAdd);
      const resultKey = JSON.stringify([agentId, lookupCwd]);
      const originalDraft: LookupDraft = {
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
      };
      const owners = new Map(
        eligible.map((row) => [row, createPreviewInterest(row)]),
      );
      for (const owner of owners.values()) pendingImports.current.add(owner);
      try {
        // A read receipt is never promoted. Unknown exact cleanup ends this
        // action before the batch can issue a fresh load or try another row.
        await release();
        const currentAction = () =>
          openRef.current &&
          currentLookup(revision, context) &&
          viewScope.current === scope &&
          eligible.every((row) => {
            const current = latestView.current.rows.find(
              (item) => item.nativeSessionId === row.nativeSessionId,
            );
            return (
              !!current &&
              historyPreviewRowKey(current) === historyPreviewRowKey(row)
            );
          });
        if (!currentAction()) return;
        const completed = new Set<string>();
        const receipts: Record<string, AddedConversation> = {};
        const { count, failures, cleanupFailed } =
          await importConversationBatch(eligible, {
            save: async (row) => {
              const owner = owners.get(row);
              if (!owner || !currentAction() || !owner.inquiryCurrent())
                return null;
              previewInterest.current = owner;
              const current = await previewHistory(agentId, row, owner);
              previewRef.current = current;
              if (!owner.inquiryCurrent()) {
                await release();
                return null;
              }
              return commitHistoryPreview(current, row.title);
            },
            release,
            onAdded: (nativeSessionId, saved) => {
              completed.add(nativeSessionId);
              receipts[nativeSessionId] = {
                saved,
                index: threads.getSnapshot().index,
              };
            },
          });
        // Interest controls further reads and writes, not the outcome of a
        // commit already dispatched for this lookup. Retain its exact saved
        // receipt and explicit failures without publishing to another lookup.
        const previous = lookupDrafts.current.get(resultKey) ?? originalDraft;
        const settled = new Set([...completed, ...failures]);
        const result: LookupDraft = {
          ...previous,
          added: { ...previous.added, ...receipts },
          selected: new Set([
            ...[...previous.selected].filter((id) => !completed.has(id)),
            ...failures,
          ]),
          failed: new Set([
            ...[...previous.failed].filter((id) => !settled.has(id)),
            ...failures,
          ]),
        };
        lookupDrafts.current.set(resultKey, result);
        if (
          !mounted.current ||
          lookupRevision.current !== revision ||
          latestView.current.agentId !== agentId ||
          latestView.current.lookupCwd !== lookupCwd
        )
          return;
        setAdded(result.added);
        setSelected(result.selected);
        setFailed(result.failed);
        setMessage(count > 0 ? S.addedCount(count) : null);
        if (cleanupFailed) setError(S.cleanupFailed);
        else if (failures.length) setError(S.addFailed);
        if (!currentAction()) return;
        try {
          await threads.refreshIndex();
        } catch {
          throw new Error(S.refreshFailed);
        }
      } finally {
        for (const owner of owners.values())
          pendingImports.current.delete(owner);
      }
    });
  const openExisting = (row: DiscoveredConversation) =>
    work(async () => {
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      const scope = viewScope.current;
      const current = () => {
        const index = threads.getSnapshot().index;
        return resolveAddedConversation(
          row,
          agentId,
          index,
          new Map(index.map((entry) => [entry.id, entry])),
          added,
        );
      };
      if (!current()) throw new Error(S.savedUnavailable);
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
      const found = current();
      if (!found) throw new Error(S.savedUnavailable);
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
      const revision = lookupRevision.current;
      const context = requestedContextRef.current;
      const scope = viewScope.current;
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
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
      const scope = viewScope.current;
      const next = useDefault
        ? null
        : await chooseDirectory(lookupCwd ?? undefined);
      if (
        (!useDefault && !next) ||
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope ||
        next === lookupCwd
      )
        return;
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
      restoreDiscovery(agentId, next);
    });
  const startNew = () => {
    if (!onNew || !agentId) return;
    const revision = lookupRevision.current;
    const context = requestedContextRef.current;
    const scope = viewScope.current;
    void work(async () => {
      await release();
      if (
        !openRef.current ||
        !currentLookup(revision, context) ||
        viewScope.current !== scope
      )
        return;
      close();
      onNew(agentId);
    });
  };
  const step = listing ? 1 : choosing ? 0 : 2;
  return open ? (
    <WorkspaceDialog
      title={S.title}
      busy={busy}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <div className="history-import">
        <HistoryReadStatus agentId={agentId} purpose="preview" active={open} />
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
            <div className="history-agent-search">
              <input
                type="search"
                aria-label={R.searchAgents}
                placeholder={R.searchAgents}
                value={agentQuery}
                onChange={(event) => setAgentQuery(event.target.value)}
              />
              <span>
                {R.agentCount(visibleAgents.length, available.length)}
              </span>
            </div>
            {available.length > 0 && visibleAgents.length === 0 && (
              <div className="history-empty" role="status">
                <strong>{R.noAgents}</strong>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setAgentQuery("")}
                >
                  {R.clearSearch}
                </button>
              </div>
            )}
            <div className="history-agent-grid">
              {visibleAgents.map((card) => (
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
                    const scope = viewScope.current;
                    await release();
                    if (openRef.current && viewScope.current === scope)
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
                {visible.map((row) => {
                  const joined = !!(
                    row.alreadyAddedId || added[row.nativeSessionId]
                  );
                  const saved = joinedRow(row);
                  return (
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
                          {joined
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
                        {joined && (
                          <>
                            <small>
                              {S.returnedLocation}：{row.cwd || S.notProvided}
                            </small>
                            {saved ? (
                              <>
                                <small>
                                  {S.savedTitle}：
                                  {saved.title?.trim()
                                    ? saved.title
                                    : S.unknownTitle}
                                </small>
                                <small>
                                  {S.savedLocation}：
                                  {saved.cwd || S.notProvided}
                                </small>
                              </>
                            ) : (
                              <small>{S.savedUnavailable}</small>
                            )}
                          </>
                        )}
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
                  );
                })}
              </div>
              <div className="history-preview">
                <h3>{S.preview}</h3>
                {previewRow ? (
                  <>
                    <h4>{previewRow.title ?? S.unknownTitle}</h4>
                    {!previewRow.alreadyAddedId &&
                      !added[previewRow.nativeSessionId] && (
                        <div className="history-recheck">
                          <p>
                            {R.body}：
                            {preview?.nativeSessionId ===
                              previewRow.nativeSessionId &&
                            preview.replayComplete
                              ? R.bodyReceived
                              : R.bodyUnknown}
                          </p>
                          {previewRow.canLoad &&
                            previewRow.locationAvailable &&
                            !previewRow.isOpen && (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  disabled={busy}
                                  onClick={() => void view(previewRow)}
                                >
                                  {R.previewRecheck}
                                </button>
                                <small>{R.previewRecheckHint}</small>
                              </>
                            )}
                        </div>
                      )}
                    {previewRow.alreadyAddedId ||
                    added[previewRow.nativeSessionId] ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy || !joinedRow(previewRow)}
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
                                  contentOrder={
                                    item.kind === "agent"
                                      ? item.contentOrder
                                      : undefined
                                  }
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
            className="btn btn-ghost history-load-more"
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
