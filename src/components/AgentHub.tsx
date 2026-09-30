import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  MagnifyingGlass,
  Plus,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import {
  agentDirectoryDescription,
  agentDirectorySource,
  agentDirectoryCategories,
  matchesAgentDirectory,
  type DirectoryCategory,
} from "../runtime/agent_directory";
import {
  authenticationRequired,
  authenticationActivity,
  useAuthentication,
} from "../runtime/authentication";
import { authActive } from "../runtime/auth_activity";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import {
  ACCESS_STRINGS as S,
  installationUnavailableLabel,
} from "../runtime/access_strings";
import { STRINGS } from "../runtime/strings";
import { programProgress } from "../runtime/program_progress";
import { AgentDetails } from "./AgentDetails";
import { AgentLogo } from "./AgentLogo";
import { ResumeDraftButton } from "./ResumeDraftButton";
import {
  AgentSetup,
  initialAgentSetupProgress,
  type AgentSetupProgress,
  type AgentSetupSelection,
} from "./AgentSetup";
import "../agent-hub.css";
import {
  preparationFor,
  pendingPreparationRead,
  preparationProgram,
  usePreparationChanges,
} from "../runtime/agent_preparation";
import {
  listCredentials,
  subscribeCredentialChanges,
} from "../runtime/credentials";
import {
  setupStorage,
  useSetupStorage,
  SETUP_STORAGE_STRINGS,
} from "../runtime/setup_storage";
import {
  locateAgentRepair,
  type AgentRepairRequest,
  type ConversationRepairContext,
} from "../runtime/agent_repair";

export interface AgentPreparationContext {
  agentId?: string;
  cwd: string;
  selection?: AgentSetupSelection;
  returnLabel?: string;
  locationLabel?: string;
  repair?: AgentRepairRequest;
  conversation?: ConversationRepairContext;
  /** Prepare a separate draft choice and return to its unchanged origin. */
  preserveOrigin?: boolean;
}
export interface AgentHubSurface {
  selected: string | null;
  detail: string | null;
  intent: "use" | "manage";
  view: "discover" | "added";
  query: string;
  source: string;
  availability: string;
  category?: DirectoryCategory;
}

export function preparationProgressKey(
  agentId: string,
  context?: AgentPreparationContext,
): string {
  return JSON.stringify([
    agentId,
    context?.cwd ?? null,
    context?.agentId === agentId ? (context.selection ?? null) : null,
  ]);
}
function progressDirectory(scope: string, fallback?: string) {
  try {
    const value: unknown = JSON.parse(scope);
    if (Array.isArray(value) && value[1] === null) return undefined;
    return Array.isArray(value) && typeof value[1] === "string"
      ? value[1]
      : fallback;
  } catch {
    return fallback;
  }
}

export interface AgentHubProps {
  preparationContext?: AgentPreparationContext;
  agents: AgentsState;
  onReturn: () => void;
  returnAfterPreparation?: boolean;
  onResumeDraft?: () => void;
  onStart: (
    agentId: string,
    selection?: AgentSetupSelection,
    destination?: "new-conversation",
  ) => void;
  onOpenApi: (agentId?: string) => void;
  onCustom?: (opener: HTMLButtonElement) => void;
  onImport?: (agentId: string, opener?: HTMLElement) => void;
  onOpenConversation?: (threadKey: string) => void;
  initialAgentId?: string | null;
  initialIntent?: "use" | "manage";
  initialView?: "discover" | "added";
  requestRevision?: number;
  returnLabel?: string;
  restoredState?: AgentHubSurface;
  onStateChange?: (state: AgentHubSurface) => void;
  active?: boolean;
}

export function agentSourceLabel(card: AgentCardModel) {
  return card.custom
    ? S.custom
    : card.source === "discovered" || card.status === "discovered"
      ? S.local
      : S.registry;
}

export function AgentHub({
  agents,
  onReturn,
  returnAfterPreparation = false,
  onResumeDraft,
  onStart,
  onOpenApi,
  onCustom,
  onImport,
  onOpenConversation,
  initialAgentId,
  initialIntent = "use",
  initialView = "discover",
  requestRevision = 0,
  returnLabel = S.returnConversation,
  restoredState,
  onStateChange,
  preparationContext,
  active = true,
}: AgentHubProps) {
  const [view, setView] = useState<"discover" | "added">(
    restoredState?.view ?? initialView,
  );
  const [query, setQuery] = useState(restoredState?.query ?? "");
  const [category, setCategory] = useState<DirectoryCategory>(
    restoredState?.category ?? "全部",
  );
  const [detail, setDetail] = useState<string | null>(null);
  const detailReturnFocus = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState<string | null>(
    initialAgentId ?? null,
  );
  const [intent, setIntent] = useState<"use" | "manage">(initialIntent);
  const [conversationProgress, setConversationProgress] = useState<
    Record<string, AgentSetupProgress>
  >({});
  const appliedRepair = useRef<string | null>(null);
  const seenEntry = useRef<string | null>(null);
  const navigationRevision = useRef(0);
  const liveEntry = useRef({ active, entry: "" });
  const [, showAccountProgress] = useState(0);
  const accountIds = agents.cards
    .map((card) => card.id)
    .sort()
    .join("\n");
  useEffect(() => {
    const off = agents.cards.map((card) =>
      authenticationActivity(card.id).subscribe(() =>
        showAccountProgress((revision) => revision + 1),
      ),
    );
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [accountIds]);
  const accountInProgress = (card: AgentCardModel) =>
    authActive(authenticationActivity(card.id).getSnapshot());
  const configuring = (card: AgentCardModel) =>
    authenticationActivity(card.id).getSnapshot()?.operation.kind ===
    "preparation";
  const setup = useSetupStorage();
  useEffect(() => {
    if (active)
      onStateChange?.({
        selected,
        detail,
        intent,
        view,
        query,
        category,
        source: "all",
        availability: "all",
      });
  }, [active, selected, detail, intent, view, query, category, onStateChange]);
  usePreparationChanges();
  const authentication = useAuthentication();
  const added = (card: AgentCardModel) =>
    card.status === "installed" || card.status === "connected";
  const entryKey = JSON.stringify([
    initialAgentId,
    initialIntent,
    initialView,
    requestRevision,
    preparationContext,
  ]);
  const effectiveIntent =
    seenEntry.current === entryKey
      ? intent
      : (restoredState?.intent ?? initialIntent);
  const effectiveSelected =
    seenEntry.current === entryKey
      ? selected
      : restoredState
        ? restoredState.selected
        : (initialAgentId ?? null);
  const selectedCard = agents.cards.find(
    (card) => card.id === effectiveSelected,
  );
  const detailCard = agents.cards.find(
    (card) =>
      card.id ===
      (seenEntry.current === entryKey
        ? detail
        : (restoredState?.detail ?? null)),
  );
  const conversationFor = (agentId: string) =>
    effectiveIntent === "manage" && preparationContext?.agentId === agentId
      ? preparationContext.conversation
      : undefined;
  const preservesOrigin = (agentId: string) =>
    preparationContext?.agentId === agentId &&
    !!preparationContext.preserveOrigin;
  const localProgress = (agentId: string) =>
    !!conversationFor(agentId) || preservesOrigin(agentId);
  const progressKey = (agentId: string) =>
    conversationFor(agentId)
      ? JSON.stringify([
          agentId,
          preparationContext!.cwd,
          "conversation",
          conversationFor(agentId)!.key,
        ])
      : preservesOrigin(agentId)
        ? preparationProgressKey(agentId, preparationContext)
        : setupStorage.scope(
            agentId,
            preparationProgressKey(agentId, preparationContext),
          );
  const setupIntent = (agentId: string) =>
    conversationFor(agentId) || preservesOrigin(agentId)
      ? "manage"
      : setupStorage.completed(agentId) &&
          (entrySelection(agentId) || setupStorage.confirmedSelection(agentId))
        ? effectiveIntent
        : "use";
  const entrySelection = (agentId: string) =>
    !preparationContext?.conversation && preparationContext?.agentId === agentId
      ? preparationContext.selection
      : undefined;
  const newSelection = (agentId: string) =>
    entrySelection(agentId) ?? setupStorage.confirmedSelection(agentId);
  const progressFor = (card: AgentCardModel): AgentSetupProgress => {
    const stored = localProgress(card.id)
      ? conversationProgress[progressKey(card.id)]
      : setup.progress[progressKey(card.id)];
    const selection = conversationFor(card.id)
      ? undefined
      : newSelection(card.id);
    if (stored)
      return !stored.selection && selection
        ? {
            ...stored,
            selection,
            choice: selection.service
              ? "api"
              : stored.choice === "api"
                ? "existing"
                : stored.choice,
          }
        : stored;
    return {
      ...initialAgentSetupProgress(selection, card.status === "connected"),
      ...(setupIntent(card.id) === "manage" ? { step: 1 } : {}),
      ...(!conversationFor(card.id) &&
      setupStorage.completed(card.id) &&
      !newSelection(card.id)
        ? { step: 2 }
        : {}),
    };
  };
  useEffect(() => {
    if (
      active &&
      setup.ready &&
      selectedCard &&
      !localProgress(selectedCard.id) &&
      !setup.progress[progressKey(selectedCard.id)]
    )
      setupStorage.remember(
        selectedCard.id,
        progressKey(selectedCard.id),
        progressFor(selectedCard),
      );
  }, [active, setup.ready, selectedCard?.id, intent, preparationContext]);
  useEffect(() => {
    if (
      !active ||
      !setup.ready ||
      restoredState ||
      appliedRepair.current === entryKey
    )
      return;
    const card = agents.cards.find((item) => item.id === initialAgentId);
    const repair =
      preparationContext?.agentId === card?.id
        ? preparationContext?.repair
        : undefined;
    if (!card || !repair) return;
    appliedRepair.current = entryKey;
    const scope = progressKey(card.id);
    const progress = locateAgentRepair(progressFor(card), repair);
    if (localProgress(card.id))
      setConversationProgress((previous) => ({
        ...previous,
        [scope]: progress,
      }));
    else setupStorage.remember(card.id, scope, progress);
  }, [active, setup.ready, entryKey, agents.cards]);
  liveEntry.current = { active, entry: entryKey };
  const prepare = (agentId: string, nextIntent: "use" | "manage" = "use") => {
    navigationRevision.current++;
    setDetail(null);
    setIntent(nextIntent);
    setSelected(agentId);
  };
  const viewProgress = (card: AgentCardModel, step: number) => {
    navigationRevision.current++;
    const scope = progressKey(card.id);
    const progress = { ...progressFor(card), step };
    if (localProgress(card.id))
      setConversationProgress((previous) => ({
        ...previous,
        [scope]: progress,
      }));
    else setupStorage.remember(card.id, scope, progress);
    // Keep this entry's intent and all choices; only locate the same operation.
    setDetail(null);
    setSelected(card.id);
  };
  const readRequired = (card: AgentCardModel) =>
    pendingPreparationRead({
      agentId: card.id,
      cwd: preparationContext?.cwd,
      service: newSelection(card.id)?.service,
    });
  const canStart = (card: AgentCardModel) =>
    setupStorage.completed(card.id) &&
    !!newSelection(card.id) &&
    !readRequired(card) &&
    card.status === "connected" &&
    !authenticationRequired(authentication, card.id, null) &&
    !agents.busy[card.id] &&
    !accountInProgress(card);
  const startOrPrepare = (card: AgentCardModel) => {
    if (accountInProgress(card)) viewProgress(card, 1);
    else if (canStart(card)) {
      setDetail(null);
      setSelected(null);
      onStart(card.id, newSelection(card.id), "new-conversation");
    } else if (readRequired(card)) viewProgress(card, 2);
    else prepare(card.id);
  };
  useEffect(() => {
    for (const card of agents.cards) {
      const preparation = preparationFor(card.id);
      const snapshot = preparation.getSnapshot();
      if (
        snapshot.input &&
        !["stale", "cancelled", "stopping", "unknown"].includes(
          snapshot.phase,
        ) &&
        (card.status !== "connected" ||
          snapshot.input.program !== preparationProgram(card))
      )
        preparation.invalidate();
    }
  }, [agents.cards]);
  useEffect(() => {
    let current = true;
    let revision = 0;
    const off = subscribeCredentialChanges(() => {
      const ticket = ++revision;
      void listCredentials()
        .then((records) => {
          if (!current || ticket !== revision) return;
          for (const card of agents.cards) {
            const preparation = preparationFor(card.id);
            const service = preparation.getSnapshot().input?.service;
            if (!service) continue;
            const record = records.find((item) => item.id === service.id);
            if (
              !record ||
              record.deleting ||
              record.revision !== service.revision ||
              !record.models.includes(service.model)
            )
              preparation.invalidate();
          }
        })
        .catch(() => {
          if (current && ticket === revision)
            for (const card of agents.cards)
              if (preparationFor(card.id).getSnapshot().input?.service)
                preparationFor(card.id).invalidate();
        });
    });
    return () => {
      current = false;
      off();
    };
  }, [agents.cards]);
  const visible = agents.cards.filter(
    (card) =>
      (view === "discover" || added(card) || !!agents.busy[card.id]) &&
      matchesAgentDirectory(card, query, category),
  );
  useEffect(() => {
    if (active && seenEntry.current !== entryKey) {
      navigationRevision.current++;
      seenEntry.current = entryKey;
      setDetail(restoredState?.detail ?? null);
      setIntent(restoredState?.intent ?? initialIntent);
      setSelected(
        restoredState ? restoredState.selected : (initialAgentId ?? null),
      );
      setView(restoredState?.view ?? initialView);
      setQuery(restoredState?.query ?? "");
      setCategory(restoredState?.category ?? "全部");
    }
  }, [entryKey, active]);
  const programStatus = (card: AgentCardModel) =>
    programProgress(agents.busy[card.id], agents.installProgress[card.id]);
  const stateLabel = (card: AgentCardModel) =>
    programStatus(card)?.label ??
    (accountInProgress(card)
      ? configuring(card)
        ? C.inProgress
        : S.loginInProgress
      : readRequired(card)
        ? C.readPending
        : authenticationRequired(authentication, card.id, null)
          ? STRINGS.agents.auth.heading
          : card.status === "connected"
            ? setupStorage.completed(card.id) && newSelection(card.id)
              ? S.connected
              : S.connectedUnfinished
            : card.status === "installed"
              ? S.registered
              : card.status === "discovered"
                ? S.discovered
                : !card.installable && !card.registerable
                  ? installationUnavailableLabel(card.platformAvailable)
                  : S.notInstalled);

  return (
    <main className="main agent-hub-main" hidden={!active}>
      <div className="topbar">
        <div className="title">
          {view === "added" ? S.myAgents : S.exploreTitle}
        </div>
        <ResumeDraftButton onClick={onResumeDraft} />
        <button className="btn btn-text" onClick={onReturn}>
          {returnLabel}
        </button>
      </div>
      <div className="agent-hub-scroll">
        <section className="agent-hub-shell">
          <header className="agent-hub-heading">
            <div>
              <div className="agent-hub-eyebrow">
                {view === "added" ? S.addedEyebrow : S.exploreTitle}
              </div>
              <h1>{view === "added" ? S.addedHeading : S.heading}</h1>
              <p>{view === "added" ? S.addedDescription : S.description}</p>
            </div>
            {onCustom && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={(event) => onCustom(event.currentTarget)}
              >
                <Plus size={16} />
                {S.customAccess}
              </button>
            )}
          </header>
          <div className="agent-hub-toolbar">
            <div className="agent-hub-tabs" aria-label={S.title}>
              {(["discover", "added"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={view === value}
                  className={view === value ? "active" : ""}
                  onClick={() => setView(value)}
                >
                  {value === "added" ? S.myAgents : S.discover}
                  {value === "added" && (
                    <span>{agents.cards.filter(added).length}</span>
                  )}
                </button>
              ))}
            </div>
            <label className="agent-hub-search">
              <MagnifyingGlass size={17} />
              <input
                aria-label={S.search}
                placeholder={S.searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  className="icon-btn"
                  aria-label={S.clearSearch}
                  onClick={() => setQuery("")}
                >
                  <X size={14} />
                </button>
              )}
            </label>
            <button
              className="btn btn-ghost agent-hub-rescan"
              disabled={agents.scanning}
              onClick={() => void agents.rescan()}
            >
              {agents.scanning ? STRINGS.agents.rescanning : S.refresh}
            </button>
          </div>
          <div className="agent-hub-filter-row">
            <div
              className="agent-hub-categories"
              role="group"
              aria-label={S.categoryLabel}
            >
              {S.categories.map((value) => (
                <button
                  key={value}
                  className={`agent-hub-category${category === value ? " active" : ""}`}
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="agent-hub-results">{S.available(visible.length)}</p>
          </div>
          {(agents.loadError || agents.errors.__scan) && (
            <p className="ac-error" role="alert">
              {agents.loadError ?? agents.errors.__scan}
            </p>
          )}
          {setup.error && (
            <p className="ac-error" role="alert">
              {setup.error}
              <button
                className="btn btn-text"
                onClick={() => void setupStorage.flush().catch(() => undefined)}
              >
                {SETUP_STORAGE_STRINGS.retry}
              </button>
            </p>
          )}
          {agents.loading ? (
            <p role="status">{STRINGS.common.loading}</p>
          ) : (
            <div className="agent-hub-grid">
              {visible.map((card) => (
                <article className="agent-hub-card" key={card.id}>
                  <div className="agent-hub-card-top">
                    <button
                      className="agent-hub-brand"
                      aria-label={`${S.details} · ${card.name}`}
                      onClick={(event) => {
                        detailReturnFocus.current = event.currentTarget;
                        setDetail(card.id);
                      }}
                    >
                      <AgentLogo card={card} />
                      <span>
                        <strong>{card.name}</strong>
                        {agentDirectorySource(card) && (
                          <small>{agentDirectorySource(card)}</small>
                        )}
                      </span>
                    </button>
                    <span
                      className={`agent-hub-badge${canStart(card) ? " ready" : ""}`}
                    >
                      {card.custom ? S.custom : S.directoryEntry}
                    </span>
                  </div>
                  <button
                    className="agent-hub-card-description"
                    onClick={(event) => {
                      detailReturnFocus.current = event.currentTarget;
                      setDetail(card.id);
                    }}
                  >
                    {agentDirectoryDescription(card)}
                  </button>
                  <div className="agent-hub-card-tags">
                    {agentDirectoryCategories(card).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className="agent-hub-card-state">
                    <span
                      className={canStart(card) ? "agent-hub-ready" : ""}
                      role={programStatus(card) ? "status" : undefined}
                    >
                      {canStart(card) ? (
                        <CheckCircle size={13} />
                      ) : (
                        <span className="agent-hub-status-dot" />
                      )}
                      {stateLabel(card)}
                    </span>
                    {card.version && (
                      <small>
                        {STRINGS.agents.connectionVersion(card.version)}
                      </small>
                    )}
                  </div>
                  <div className="agent-hub-card-actions">
                    <button
                      className={`btn agent-hub-start ${canStart(card) ? "btn-primary" : "btn-ghost"}`}
                      disabled={!setup.ready}
                      onClick={() =>
                        programStatus(card)
                          ? viewProgress(card, 0)
                          : startOrPrepare(card)
                      }
                    >
                      {programStatus(card)
                        ? S.viewProgress
                        : accountInProgress(card)
                          ? configuring(card)
                            ? C.resume
                            : S.resumeLogin
                          : canStart(card)
                            ? S.start
                            : added(card)
                              ? S.continueSetup
                              : S.prepare}
                      <ArrowRight size={14} />
                    </button>
                    <button
                      className="btn btn-ghost agent-hub-detail-button"
                      aria-label={`${S.manage} · ${card.name}`}
                      disabled={!setup.ready}
                      onClick={() => prepare(card.id, "manage")}
                    >
                      <SlidersHorizontal size={17} />
                    </button>
                  </div>
                  {agents.errors[card.id] && (
                    <p className="ac-error" role="alert">
                      {agents.errors[card.id]}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
          {!agents.loading && visible.length === 0 && (
            <div className="agent-hub-empty">
              <h2>
                {view === "added" && !agents.cards.some(added)
                  ? S.noAdded
                  : S.noMatches}
              </h2>
              <p>
                {view === "added" && !agents.cards.some(added)
                  ? S.noAddedHint
                  : S.noMatchesHint}
              </p>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setView("discover");
                  setQuery("");
                  setCategory("全部");
                }}
              >
                {view === "added" && !agents.cards.some(added)
                  ? S.discover
                  : S.resetSearch}
              </button>
            </div>
          )}
          <footer className="agent-hub-footer">
            <span>{S.directoryFooter}</span>
          </footer>
        </section>
      </div>
      {detailCard && (
        <AgentDetails
          card={{
            ...detailCard,
            description: agentDirectoryDescription(detailCard),
          }}
          agents={agents}
          active={active}
          source={agentSourceLabel(detailCard)}
          onClose={() => setDetail(null)}
          onPrepare={() => startOrPrepare(detailCard)}
          canStart={canStart(detailCard)}
          returnFocusRef={detailReturnFocus}
        />
      )}
      {selectedCard && setup.ready && (
        <AgentSetup
          key={progressKey(selectedCard.id)}
          intent={setupIntent(selectedCard.id)}
          cwd={progressDirectory(
            progressKey(selectedCard.id),
            preparationContext?.cwd,
          )}
          returnLabel={preparationContext?.returnLabel}
          locationLabel={
            progressKey(selectedCard.id) ===
            preparationProgressKey(selectedCard.id, preparationContext)
              ? preparationContext?.locationLabel
              : progressDirectory(progressKey(selectedCard.id))
          }
          card={selectedCard}
          agents={agents}
          active={active}
          progress={progressFor(selectedCard)}
          conversation={conversationFor(selectedCard.id)}
          sourceContext={
            conversationFor(selectedCard.id)?.sourceContext ??
            (progressKey(selectedCard.id) ===
              preparationProgressKey(selectedCard.id, preparationContext) &&
            JSON.stringify(
              progressFor(selectedCard).selection?.service ?? null,
            ) ===
              JSON.stringify(entrySelection(selectedCard.id)?.service ?? null)
              ? preparationContext?.repair?.sourceContext
              : undefined)
          }
          onProgress={(progress) => {
            const scope = progressKey(selectedCard.id);
            if (localProgress(selectedCard.id))
              setConversationProgress((previous) => ({
                ...previous,
                [scope]: progress,
              }));
            else setupStorage.remember(selectedCard.id, scope, progress);
          }}
          onClose={() => {
            navigationRevision.current++;
            setSelected(null);
            if (
              returnAfterPreparation ||
              (initialAgentId === selectedCard.id && initialIntent === "manage")
            )
              onReturn();
          }}
          onStart={async (agentId, selection) => {
            if (conversationFor(agentId) || setupIntent(agentId) === "manage") {
              onReturn();
              return;
            }
            if (selectedCard.status !== "connected" || !selection) return;
            const owner = navigationRevision.current;
            const entry = entryKey;
            const saved = await setupStorage.complete(agentId, selection);
            if (
              !saved ||
              !liveEntry.current.active ||
              liveEntry.current.entry !== entry ||
              navigationRevision.current !== owner
            )
              return;
            setSelected(null);
            onStart(agentId, saved, "new-conversation");
          }}
          onConfirmManagement={
            conversationFor(selectedCard.id)
              ? undefined
              : async (agentId, selection) => {
                  if (
                    setupIntent(agentId) !== "manage" ||
                    selectedCard.status !== "connected"
                  )
                    return false;
                  const owner = navigationRevision.current;
                  const entry = entryKey;
                  const saved = await setupStorage.complete(agentId, selection);
                  return (
                    !!saved &&
                    liveEntry.current.active &&
                    liveEntry.current.entry === entry &&
                    navigationRevision.current === owner
                  );
                }
          }
          onOpenApi={onOpenApi}
          onOpenConversation={
            onOpenConversation
              ? (key) => {
                  onOpenConversation(key);
                }
              : undefined
          }
          onImport={
            onImport
              ? (agentId, opener) => {
                  onImport(agentId, opener);
                }
              : undefined
          }
        />
      )}
    </main>
  );
}
