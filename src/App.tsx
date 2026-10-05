import type { BrowserWorkspaceState } from "./runtime/browser_workspace";
import { browserSurfaceGuard } from "./runtime/browser_surface";
import { BrowserSurfaceNotice } from "./components/BrowserSurfaceNotice";
import { replacesDraftChoice } from "./runtime/draft_choice";
import { startWorkEvents } from "./runtime/work_policy";
import { startAutoArchive } from "./runtime/auto_archive";
import { notificationNavigation } from "./runtime/notification_navigation";
import { NOTIFICATION_STRINGS as NOTICES } from "./runtime/desktop_notifications";
import {
  canMarkConversationRead,
  useVisibleConversation,
} from "./runtime/conversation_read_state";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  FilesIcon,
  GlobeIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { SettingsPage, type SettingsTab } from "./components/SettingsPage";
import { CustomAgentDialog } from "./components/CustomAgentDialog";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import {
  AgentHub,
  type AgentHubSurface,
  type AgentPreparationContext,
} from "./components/AgentHub";
import type { ServiceChoice } from "./components/ServicePicker";
import { ConversationLibrary } from "./components/ConversationLibrary";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { WorkspaceActionMenu } from "./components/WorkspaceActionMenu";
import { ImportConversations } from "./components/ImportConversations";
import { useAgents } from "./runtime/agents";
import {
  hasSavedAgentPreparation,
  useConversationAgentReadiness,
} from "./runtime/agent_readiness";
import { isAgentPresentable } from "./runtime/agent_directory";
import { allowAutomaticConnection } from "./runtime/connection_intent";
import {
  CollectionActionScope,
  normalizeLibraryFilter,
  type LibraryFilter,
} from "./runtime/collections";
import { composerDrafts, newConversationChoice } from "./runtime/drafts";
import { LIBRARY } from "./runtime/library_strings";
import { useArchiveBlockReasons } from "./runtime/archive_blockers";
import { IMPORT_STRINGS } from "./runtime/import_strings";
import { ACCESS_STRINGS } from "./runtime/access_strings";
import { traceAfterPaint } from "./runtime/performance-trace";
import {
  threads,
  paneCards,
  basename,
  hasActiveTools,
  useThread,
  useThreadsSnapshot,
  type IndexRow,
  type SidebarRow,
} from "./runtime/sessions";
import { STRINGS } from "./runtime/strings";
import { WORKSPACE_STRINGS as W } from "./runtime/workspace_strings";
import { readableTranscript } from "./runtime/readable_transcript";
import { uiError } from "./runtime/ui_error";
import { historyFailureKey } from "./runtime/session_recovery";
import { useThemePreference } from "./runtime/theme";
import {
  authenticationRequired,
  useAuthentication,
} from "./runtime/authentication";
import {
  agentRepairPanel,
  draftPreparationRequired,
  draftPreparationSelection,
  conversationRepairContext,
  type AgentRepairRequest,
} from "./runtime/agent_repair";

type View = (
  | { kind: "start" }
  | { kind: "thread"; key: string }
  | { kind: "library" }
  | {
      kind: "agents";
      entry?: {
        target: string | null;
        intent: "use" | "manage";
        directoryView: "discover" | "added";
        context?: AgentPreparationContext;
        surface?: AgentHubSurface;
        draft: ReturnType<typeof composerDrafts.read> | null;
      };
    }
  | { kind: "settings"; tab?: SettingsTab }
) & { historyImport?: true };
type PreparedSelection = {
  service: ServiceChoice | null;
  config: Record<string, unknown>;
};
function afterBrowserClose<Args extends unknown[]>(
  action: (...args: Args) => void,
) {
  return (...args: Args) =>
    browserSurfaceGuard.runLatest(() => action(...args));
}
function ThreadPage({
  onManualOpen,
  viewKey,
  active,
  agents,
  onGoSettings,
  onOpened,
  onRecover,
  onBack,
  onNew,
  navToggle,
  defaultCwd,
  onBrowserStateChange,
  draftComposerRef,
}: {
  onManualOpen?: () => void;
  draftComposerRef?: React.Ref<HTMLDivElement>;
  onBrowserStateChange?: (
    taskKey: string,
    page: BrowserWorkspaceState | null,
  ) => void;
  viewKey: string;
  active: boolean;
  agents: ReturnType<typeof useAgents>;
  onGoSettings: () => void;
  onOpened: (key: string) => void;
  onRecover?: (key: string) => Promise<void>;
  onBack: () => void;
  onNew: () => void;
  navToggle: React.ReactNode;
  defaultCwd?: string | null;
}) {
  const thread = useThread(viewKey);
  useEffect(() => {
    // A discarded empty draft no longer needs a retained render slot. Its
    // native close still belongs to the existing guard, including retries.
    if (!thread) onBrowserStateChange?.(viewKey, null);
  }, [thread, viewKey, onBrowserStateChange]);
  useVisibleConversation(
    active && thread ? viewKey : null,
    canMarkConversationRead(thread),
  );
  const snapshot = useThreadsSnapshot();
  const row = snapshot.index.find((r) => r.id === viewKey);
  const archiveReason = useArchiveBlockReasons([viewKey]).get(viewKey);
  const archiveBlocked = !row?.archived && archiveReason;
  const title = thread?.title || row?.title || STRINGS.sessions.newSession;
  const artifactCount = thread ? paneCards(thread).length : 0;
  const canCopy =
    !!thread &&
    (thread.items.length > 0 ||
      thread.pendingPermissions.length > 0 ||
      thread.pendingElicitations.length > 0);
  const [contentMode, setContentMode] = useState<"files" | "browser">("files");
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(0);
  const host = useRef<HTMLElement>(null);
  const artifactReturnFocus = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [rename, setRename] = useState(false);
  const [name, setName] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const actions = useRef(new CollectionActionScope());
  const closeDialog = () => {
    actions.current.invalidate();
    setMenu(false);
    setRename(false);
    setError(null);
  };
  useEffect(() => {
    if (!active) closeDialog();
    return () => actions.current.invalidate();
  }, [active, viewKey]);
  const mutate = (action: () => Promise<void>) =>
    actions.current.run(action, {
      pending: setSaving,
      success: closeDialog,
      failure: (reason) => setError(uiError(reason, LIBRARY.error)),
    });
  useEffect(() => {
    const nodes = [
      ...(host.current?.querySelectorAll<HTMLElement>(
        ".msg-user, .assistant, .thinking-block, .steps",
      ) ?? []),
    ];
    const needle = query.trim().toLocaleLowerCase();
    const found = nodes.filter(
      (n) => !!needle && n.textContent?.toLocaleLowerCase().includes(needle),
    );
    nodes.forEach((n) => n.classList.toggle("search-match", found.includes(n)));
    setMatches(found.length);
    found[0]?.scrollIntoView({ block: "center" });
  }, [query, thread?.items.length]);
  const header = (
    <>
      <header className="workspace-topbar thread-topbar">
        {navToggle}
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.back}
          onClick={onBack}
        >
          <ArrowLeftIcon size={19} />
        </button>
        <div className="thread-title">
          <h1 title={title}>{title}</h1>
          <span title={thread?.cwd ?? row?.cwd}>
            {(thread?.cwd ?? row?.cwd) === defaultCwd
              ? LIBRARY.ordinary
              : basename(thread?.cwd ?? row?.cwd ?? "")}
            {thread && (
              <>
                {" "}
                ·{" "}
                {threads.needsAttention(thread)
                  ? LIBRARY.attention
                  : thread.running || hasActiveTools(thread)
                    ? LIBRARY.running
                    : LIBRARY.notRunning}
              </>
            )}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.find}
          onClick={() => setFinding(!finding)}
        >
          <MagnifyingGlassIcon size={20} />
        </button>
        <button
          type="button"
          className={`btn btn-ghost ${thread?.artifactPaneOpen ? "active" : ""}`}
          aria-label={thread?.artifactPaneOpen ? W.hideContent : W.showContent}
          title={thread?.artifactPaneOpen ? W.hideContent : W.showContent}
          aria-expanded={thread?.artifactPaneOpen ?? false}
          disabled={!thread}
          onClick={(event) => {
            if (thread?.artifactPaneOpen) threads.closeArtifactPane(viewKey);
            else {
              artifactReturnFocus.current = event.currentTarget;
              threads.openArtifactPane(viewKey);
            }
          }}
        >
          <FilesIcon size={20} />
          <span>{W.content}</span>
          {artifactCount > 0 && <small>{artifactCount}</small>}
        </button>
        <button
          type="button"
          className="icon-button desktop-browser-entry"
          aria-label={W.browser}
          title={W.browser}
          disabled={!thread}
          onClick={(event) => {
            artifactReturnFocus.current = event.currentTarget;
            setContentMode("browser");
            threads.openArtifactPane(viewKey);
          }}
        >
          <GlobeIcon size={20} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={LIBRARY.actions(title)}
          ref={menuAnchor}
          aria-expanded={menu}
          aria-haspopup="dialog"
          onClick={() => {
            browserSurfaceGuard.runLatest(() => {
              actions.current.invalidate();
              setError(null);
              setMenu(!menu);
            });
          }}
        >
          <DotsThreeIcon size={22} />
        </button>
      </header>
      {finding && (
        <div className="thread-find">
          <input
            autoFocus
            aria-label={LIBRARY.find}
            placeholder={LIBRARY.findPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span>
            {query
              ? matches
                ? LIBRARY.findCount(matches)
                : LIBRARY.findEmpty
              : ""}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={LIBRARY.cancel}
            onClick={() => {
              setFinding(false);
              setQuery("");
            }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
  return (
    <main className="main workspace-thread" ref={host}>
      {thread ? (
        <ThreadView
          contentMode={contentMode}
          onContentModeChange={setContentMode}
          key={thread.key}
          thread={thread}
          active={active && !menu && !rename}
          agents={agents.cards}
          onGoSettings={onGoSettings}
          onOpened={onOpened}
          onRecover={onRecover}
          onNew={onNew}
          header={header}
          artifactReturnFocusRef={artifactReturnFocus}
          onBrowserStateChange={onBrowserStateChange}
          draftComposerRef={draftComposerRef}
        />
      ) : (
        <>
          {header}
          <div className="library-empty">
            {onManualOpen ? (
              <>
                <p>{NOTICES.coldConversation}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onManualOpen}
                >
                  {NOTICES.openConversation}
                </button>
              </>
            ) : (
              STRINGS.common.loading
            )}
          </div>
        </>
      )}
      {active && menu && (
        <WorkspaceActionMenu
          anchor={menuAnchor.current}
          title={title}
          onClose={closeDialog}
        >
          <div className="workspace-action-body">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canCopy || saving}
              onClick={() =>
                void mutate(() =>
                  navigator.clipboard.writeText(
                    readableTranscript(
                      host.current?.querySelector(".transcript") ?? null,
                      title,
                    ),
                  ),
                )
              }
            >
              {LIBRARY.copy}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving}
              onClick={() => {
                setName(title);
                setRename(true);
                setMenu(false);
              }}
            >
              {LIBRARY.rename}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving}
              onClick={() =>
                void mutate(() => threads.setPinned(viewKey, !row?.pinned))
              }
            >
              {row?.pinned ? LIBRARY.unfavorite : LIBRARY.favorite}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!row || saving || Boolean(archiveBlocked)}
              aria-describedby={
                archiveBlocked ? "thread-archive-reason" : undefined
              }
              onClick={() =>
                void mutate(() => threads.setArchived(viewKey, !row?.archived))
              }
            >
              {row?.archived ? LIBRARY.restore : LIBRARY.archive}
            </button>
            {archiveBlocked && (
              <p className="archive-block-reason" id="thread-archive-reason">
                {LIBRARY.archiveReasons[archiveBlocked]}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </WorkspaceActionMenu>
      )}
      {active && rename && (
        <WorkspaceDialog
          title={LIBRARY.rename}
          onClose={closeDialog}
          returnFocusRef={menuAnchor}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim())
                void mutate(() => threads.rename(viewKey, name.trim()));
            }}
          >
            <div className="workspace-dialog-body">
              <label>
                {LIBRARY.title}
                <input
                  autoFocus
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              <button
                className="btn btn-primary"
                disabled={!name.trim() || saving}
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

export default function App() {
  const [themeMode, setThemeMode, themeStatus] = useThemePreference();
  const agents = useAgents();
  const readyForConversation = useConversationAgentReadiness(agents.cards);
  const index = useSyncExternalStore(
    threads.subscribe,
    () => threads.getSnapshot().index,
  );
  const historyAgents = new Set(index.map((row) => row.agentId));
  const currentReadiness = useRef(readyForConversation);
  currentReadiness.current = readyForConversation;
  const currentAgentCards = useRef(agents.cards);
  currentAgentCards.current = agents.cards;
  const unreadyCandidate = (id: string) =>
    currentAgentCards.current.some(
      (card) => card.id === id && !currentReadiness.current(id),
    );
  const authentication = useAuthentication();
  useEffect(startWorkEvents, []);
  useEffect(startAutoArchive, []);
  const [view, updateView] = useState<View>(() =>
    window.location.hash === "#settings"
      ? { kind: "settings" }
      : { kind: "start" },
  );
  const currentView = useRef(view);
  const historyOpen = useRef(0);
  const setView = (next: View) => {
    currentView.current = next;
    updateView(next);
  };
  const routeHistory = useRef<View[]>([]);
  const [threadKey, setThreadKey] = useState<string | null>(null);
  const [notificationOnlyKey, setNotificationOnlyKey] = useState<string | null>(
    null,
  );
  const [preparedDraftKey, setPreparedDraftKey] = useState<string | null>(null);
  const currentPreparedDraftKey = useRef(preparedDraftKey);
  currentPreparedDraftKey.current = preparedDraftKey;
  const [draftComposerTarget, setDraftComposerTarget] =
    useState<HTMLDivElement | null>(null);
  const visiblePageKey =
    view.kind === "thread"
      ? threadKey
      : view.kind === "start"
        ? preparedDraftKey
        : null;
  // One native page exists. Keep only its existing conversation mounted while
  // visiting another task so real permission/timeout receipts remain observed.
  const [browserOwner, setBrowserOwner] = useState<{
    taskKey: string;
    label: string;
  } | null>(null);
  const observeBrowserPage = (
    taskKey: string,
    page: BrowserWorkspaceState | null,
  ) => {
    setBrowserOwner((previous) => {
      if (!page || page.phase === "closed")
        return previous?.taskKey === taskKey &&
          (!page || previous.label === page.label)
          ? null
          : previous;
      if (
        page.taskKey !== taskKey ||
        (previous &&
          previous.taskKey !== taskKey &&
          (currentView.current.kind === "thread"
            ? currentView.current.key !== taskKey
            : currentView.current.kind !== "start" ||
              currentPreparedDraftKey.current !== taskKey))
      )
        return previous;
      return previous?.taskKey === taskKey && previous.label === page.label
        ? previous
        : { taskKey, label: page.label };
    });
  };
  const pendingCanonical = useRef<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const stop = browserSurfaceGuard.subscribe(() => {
      // Notifications precede the queued action. Reconcile afterwards so a
      // layout-only intent cannot strand the view under its old history key.
      queueMicrotask(() => {
        const state = browserSurfaceGuard.getSnapshot();
        if (
          !mounted ||
          state.busy ||
          state.failed ||
          browserSurfaceGuard.hasPendingNavigation
        )
          return;
        const key = pendingCanonical.current;
        if (!key) return;
        pendingCanonical.current = null;
        if (
          currentView.current.kind === "thread" &&
          currentView.current.key === key
        ) {
          setThreadKey(key);
          updateView(currentView.current);
        }
      });
    });
    return () => {
      mounted = false;
      stop();
    };
  }, []);
  const [filter, setFilter] = useState<LibraryFilter>({ kind: "all" });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsMounted, setSettingsMounted] = useState(
    view.kind === "settings",
  );
  const [customAgentOpen, setCustomAgentOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const importReturnFocus = useRef<HTMLElement | null>(null);
  const customReturnFocus = useRef<HTMLElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState(false);
  const [newAgent, setNewAgent] = useState<string | null>(null);
  const [agentRequest, setAgentRequest] = useState(0);
  const [preparedSelection, setPreparedSelection] = useState<
    PreparedSelection | undefined
  >();
  const [pendingAgent, setPendingAgent] = useState<{
    id: string;
    selection?: PreparedSelection;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importMounted, setImportMounted] = useState(false);
  const [importAgent, setImportAgent] = useState<string | null>(null);
  const [importRequest, setImportRequest] = useState(0);
  const openImport = afterBrowserClose(
    (agentId: string | null = null, opener?: HTMLElement) => {
      importReturnFocus.current = opener ?? null;
      setImportAgent(agentId);
      setImportRequest((n) => n + 1);
      setImportMounted(true);
      setImportOpen(true);
    },
  );
  const [hubMounted, setHubMounted] = useState(false);
  const [hubTarget, setHubTarget] = useState<string | null>(null);
  const [hubIntent, setHubIntent] = useState<"use" | "manage">("use");
  const [hubView, setHubView] = useState<"discover" | "added">("discover");
  const [hubRequest, setHubRequest] = useState(0);
  const [hubRestoredState, setHubRestoredState] = useState<AgentHubSurface>();
  const hubSurface = useRef<AgentHubSurface | undefined>(undefined);
  const originatingDraft = useRef<ReturnType<
    typeof composerDrafts.read
  > | null>(null);
  const [hubContext, setHubContext] = useState<AgentPreparationContext>();
  const [actionError, setActionError] = useState<string | null>(null);
  const loadDirectory = () => {
    setCwdError(false);
    void invoke<string>("app_default_working_directory")
      .then(setDefaultCwd)
      .catch(() => setCwdError(true));
  };
  useEffect(() => {
    loadDirectory();
    void threads.refreshIndex();
  }, []);
  const connectedKey = agents.cards
    .filter((c) => c.status === "connected")
    .map((c) => c.id)
    .sort()
    .join(",");
  useEffect(() => {
    void threads.refreshIndex();
  }, [connectedKey]);
  useEffect(() => {
    const timer = setInterval(() => void threads.refreshIndex(), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!agents.loading) traceAfterPaint("shell_ready");
  }, [agents.loading]);
  const showLibrary = afterBrowserClose((next: LibraryFilter) => {
    routeHistory.current = [];
    setFilter((current) =>
      next.kind === "agent" || next.kind === "group"
        ? {
            ...normalizeLibraryFilter(current),
            kind: "selection",
            favorites: false,
            [next.kind]: next.id,
          }
        : next,
    );
    setView({ kind: "library" });
  });
  const goNew = afterBrowserClose(() => {
    routeHistory.current = [];
    setView({ kind: "start" });
  });
  const rememberOrigin = (historyImport = false) => {
    const originView = currentView.current;
    const origin: View =
      originView.kind === "settings"
        ? { ...originView, tab: settingsTab }
        : originView.kind === "agents"
          ? {
              kind: "agents",
              entry: {
                target: hubTarget,
                intent: hubIntent,
                directoryView: hubView,
                context: hubContext,
                surface: hubSurface.current,
                draft: originatingDraft.current,
              },
            }
          : originView;
    routeHistory.current.push(
      historyImport ? { ...origin, historyImport: true } : origin,
    );
  };
  const returnToOrigin = afterBrowserClose(() => {
    const { historyImport, ...previous } = routeHistory.current.pop() ?? {
      kind: "start",
    };
    if (previous.kind === "thread") setThreadKey(previous.key);
    if (previous.kind === "agents" && previous.entry) {
      setHubTarget(previous.entry.target);
      setHubIntent(previous.entry.intent);
      setHubView(previous.entry.directoryView);
      setHubContext(previous.entry.context);
      setHubRestoredState(previous.entry.surface);
      originatingDraft.current = previous.entry.draft;
      setHubRequest((revision) => revision + 1);
    }
    if (previous.kind === "settings" && previous.tab)
      setSettingsTab(previous.tab);
    setView(previous);
    if (historyImport) setImportOpen(true);
  });
  const openSettings = afterBrowserClose((tab: SettingsTab = "general") => {
    if (view.kind !== "settings") rememberOrigin();
    setSettingsTab(tab);
    setSettingsMounted(true);
    setView({ kind: "settings" });
  });
  const openAgents = afterBrowserClose(
    (
      agentId?: string,
      intent: "use" | "manage" = "use",
      repair?: AgentRepairRequest,
    ) => {
      if (view.kind !== "agents") rememberOrigin();
      setHubTarget(agentId ?? null);
      setHubRestoredState(undefined);
      setHubIntent(intent);
      setHubView(intent === "manage" ? "added" : "discover");
      setHubRequest((revision) => revision + 1);
      originatingDraft.current =
        view.kind === "start" ? composerDrafts.read("new") : null;
      setHubContext(
        view.kind === "start" && defaultCwd
          ? {
              agentId: newConversationChoice.agentId ?? undefined,
              cwd: newConversationChoice.cwd ?? defaultCwd,
              locationLabel: newConversationChoice.cwd ?? LIBRARY.ordinary,
              selection: {
                service: newConversationChoice.service,
                config: { ...newConversationChoice.config },
              },
              repair,
            }
          : view.kind === "thread" &&
              intent === "manage" &&
              agentId === threads.thread(view.key)?.agentId
            ? {
                agentId: threads.thread(view.key)!.agentId,
                cwd: threads.thread(view.key)!.cwd,
                returnLabel: ACCESS_STRINGS.returnConversation,
                ...(draftPreparationRequired(threads.thread(view.key)) &&
                repair?.panel === "model"
                  ? {
                      preserveOrigin: true,
                      selection: draftPreparationSelection(
                        threads.thread(view.key)!,
                      ),
                    }
                  : {
                      conversation: conversationRepairContext(
                        threads.thread(view.key)!,
                      ),
                    }),
                repair,
              }
            : undefined,
      );
      setHubMounted(true);
      setView({ kind: "agents" });
    },
  );
  const prepareHistoryAgent = afterBrowserClose(
    (agentId: string | undefined, cwd: string | null) => {
      rememberOrigin(true);
      setImportOpen(false);
      setHubTarget(agentId ?? null);
      setHubRestoredState(undefined);
      setHubIntent("manage");
      setHubView("added");
      setHubRequest((revision) => revision + 1);
      originatingDraft.current = null;
      setHubContext(
        cwd || defaultCwd
          ? {
              agentId,
              cwd: cwd ?? defaultCwd!,
              returnLabel: IMPORT_STRINGS.returnToHistory,
              locationLabel: cwd ?? IMPORT_STRINGS.defaultScope,
            }
          : undefined,
      );
      setHubMounted(true);
      setView({ kind: "agents" });
    },
  );
  const opened = afterBrowserClose((key: string) => {
    setThreadKey(key);
    setView({ kind: "thread", key });
  });
  const followRecovery = (
    originalKey: string,
    request: number,
    canonicalKey?: string,
  ) => {
    if (!canonicalKey || request !== historyOpen.current) return;
    // Repair this open's existing return path without navigating away from
    // settings or preparation. No global native-id lookup or alias storage.
    routeHistory.current = routeHistory.current.map((origin) =>
      origin.kind === "thread" && origin.key === originalKey
        ? { ...origin, key: canonicalKey }
        : origin,
    );
    if (
      currentView.current.kind === "thread" &&
      currentView.current.key === originalKey
    ) {
      if (!browserSurfaceGuard.hasPendingNavigation) opened(canonicalKey);
      else {
        // A newer route is still waiting for native close. Repair the identity
        // used by rememberOrigin without replacing that queued destination.
        currentView.current = { kind: "thread", key: canonicalKey };
        pendingCanonical.current = canonicalKey;
      }
    }
  };
  const recover = async (key: string) => {
    if (
      currentView.current.kind !== "thread" ||
      currentView.current.key !== key
    )
      return;
    const target = threads.thread(key);
    if (target) allowAutomaticConnection(target.agentId);
    const request = ++historyOpen.current;
    try {
      const state = await threads.reconnect(key);
      followRecovery(key, request, state?.key);
    } catch (error) {
      followRecovery(key, request, historyFailureKey(error));
    }
  };
  const openRow = afterBrowserClose((row: IndexRow | SidebarRow) => {
    setNotificationOnlyKey(null);
    allowAutomaticConnection(row.agentId);
    const request = ++historyOpen.current;
    routeHistory.current = [];
    setPaletteOpen(false);
    const key = "key" in row ? row.key : row.id;
    const existing = threads.thread(key);
    if (existing) traceAfterPaint("thread_switch", Date.now());
    opened(key);
    if (!row.nativeSessionId) {
      threads.markOpenFailed(
        key,
        row.agentId,
        row.cwd,
        "",
        STRINGS.thread.notResumable,
        true,
      );
      return;
    }
    if (existing && !existing.connectionLost && !existing.openError) return;
    void threads
      .open({
        agentId: row.agentId,
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
      })
      .then(
        (state) => followRecovery(key, request, state.key),
        (error) => followRecovery(key, request, historyFailureKey(error)),
      );
  });
  const notificationSelection = useRef<(key: string) => void>(() => {});
  notificationSelection.current = (key) => {
    // A click is a navigation request, never permission to recover or send.
    if (!threads.getSnapshot().index.some((row) => row.id === key)) return;
    browserSurfaceGuard.runLatest(() => {
      if (!threads.getSnapshot().index.some((row) => row.id === key)) return;
      ++historyOpen.current;
      routeHistory.current = [];
      setPaletteOpen(false);
      setNotificationOnlyKey(threads.thread(key) ? null : key);
      opened(key);
    });
  };
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void notificationNavigation(async (key) => {
      await threads.refreshIndex();
      if (!disposed) notificationSelection.current(key);
    })
      .then((off) => {
        if (disposed) off();
        else stop = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const useAgent = afterBrowserClose(
    (
      agentId: string,
      selection?: PreparedSelection,
      destination?: "new-conversation",
    ) => {
      if (
        routeHistory.current.at(-1)?.historyImport ||
        (destination !== "new-conversation" &&
          routeHistory.current.at(-1)?.kind === "thread")
      ) {
        returnToOrigin();
        return;
      }
      if (unreadyCandidate(agentId)) return;
      const draft = composerDrafts.read("new");
      if (
        (draft.text.trim() || draft.attachments.length) &&
        draft !== originatingDraft.current &&
        replacesDraftChoice(newConversationChoice, agentId, selection)
      ) {
        setPendingAgent({ id: agentId, selection });
        return;
      }
      allowAutomaticConnection(agentId);
      setNewAgent(agentId);
      setPreparedSelection(selection);
      setAgentRequest((n) => n + 1);
      goNew();
    },
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector("dialog[open], .workspace-action-menu")
      )
        return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (meta && (key === "k" || (event.shiftKey && key === "p"))) {
        event.preventDefault();
        if (!paletteOpen)
          searchReturnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        browserSurfaceGuard.runLatest(() => setPaletteOpen((v) => !v));
      } else if (meta && key === ",") {
        event.preventDefault();
        setPaletteOpen(false);
        openSettings();
      } else if (meta && key === "n") {
        event.preventDefault();
        goNew();
      } else if (event.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (view.kind === "settings" || view.kind === "agents")
          returnToOrigin();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, view.kind]);
  const navToggle = !sidebarOpen ? (
    <button
      type="button"
      className="icon-button"
      aria-label={LIBRARY.expandNav}
      onClick={() => browserSurfaceGuard.runLatest(() => setSidebarOpen(true))}
    >
      <SidebarSimpleIcon size={20} />
    </button>
  ) : null;
  return (
    <div className="app product-app">
      <BrowserSurfaceNotice />
      <div className="body-row">
        {sidebarOpen && (
          <Sidebar
            agents={agents.cards.filter(
              (card) =>
                isAgentPresentable(card) &&
                (hasSavedAgentPreparation(card.id) ||
                  historyAgents.has(card.id)),
            )}
            active={view.kind}
            filter={filter}
            onNew={goNew}
            onLibrary={showLibrary}
            onSearch={(opener) => {
              searchReturnFocus.current = opener;
              browserSurfaceGuard.runLatest(() => setPaletteOpen(true));
            }}
            onSettings={() => openSettings()}
            onExplore={() => openAgents()}
            onCollapse={() =>
              browserSurfaceGuard.runLatest(() => setSidebarOpen(false))
            }
          />
        )}
        {!sidebarOpen &&
          (view.kind === "agents" || view.kind === "settings") && (
            <div className="collapsed-nav">{navToggle}</div>
          )}
        <div
          className="workspace-route"
          hidden={view.kind !== "start" || !!preparedDraftKey}
        >
          {cwdError ? (
            <main className="main">
              <header className="workspace-topbar">{navToggle}</header>
              <div className="library-empty">
                <p role="alert">{LIBRARY.defaultDirectoryError}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={loadDirectory}
                >
                  {LIBRARY.retry}
                </button>
              </div>
            </main>
          ) : agents.loading || !defaultCwd ? (
            <main className="main">
              <div className="library-empty">{LIBRARY.loading}</div>
            </main>
          ) : agents.loadError ? (
            <main className="main">
              <div className="library-empty">
                <p role="alert">{agents.loadError}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void agents.refresh()}
                >
                  {LIBRARY.retry}
                </button>
              </div>
            </main>
          ) : (
            <EmptyState
              agents={agents.cards}
              defaultCwd={defaultCwd}
              initialAgentId={newAgent}
              initialAgentRevision={agentRequest}
              initialSelection={preparedSelection}
              active={view.kind === "start" && !paletteOpen && !importOpen}
              onPreparedKey={setPreparedDraftKey}
              composerTarget={draftComposerTarget}
              header={
                <header className="workspace-topbar start-context">
                  {navToggle}
                  <h1>{LIBRARY.newChat}</h1>
                </header>
              }
              onProjectChange={() => undefined}
              onGoSettings={(agentId, repair) =>
                openAgents(agentId, "use", repair)
              }
              onManageServices={() => openSettings("keys")}
              onStarted={opened}
            />
          )}
        </div>
        <div className="workspace-route" hidden={view.kind !== "library"}>
          <ConversationLibrary
            active={view.kind === "library" && !paletteOpen && !importOpen}
            agents={agents.cards}
            filter={filter}
            onFilter={setFilter}
            onOpen={openRow}
            onImport={(opener) => openImport(null, opener)}
            onNew={goNew}
            defaultCwd={defaultCwd}
            header={navToggle}
          />
        </div>
        {[
          ...new Set(
            [threadKey, preparedDraftKey, browserOwner?.taskKey].filter(
              (key): key is string => !!key,
            ),
          ),
        ].map((pageKey) => (
          <div
            key={pageKey}
            className="workspace-route"
            hidden={pageKey !== visiblePageKey}
          >
            <ThreadPage
              viewKey={pageKey}
              onManualOpen={
                notificationOnlyKey === pageKey
                  ? () => {
                      const row = threads
                        .getSnapshot()
                        .index.find((item) => item.id === pageKey);
                      if (row) openRow(row);
                    }
                  : undefined
              }
              active={pageKey === visiblePageKey && !paletteOpen && !importOpen}
              onBrowserStateChange={observeBrowserPage}
              draftComposerRef={
                pageKey === preparedDraftKey
                  ? setDraftComposerTarget
                  : undefined
              }
              agents={agents}
              onNew={goNew}
              onGoSettings={() => {
                const current = threads.thread(pageKey);
                const sourceContext = current
                  ? conversationRepairContext(current).sourceContext
                  : undefined;
                const needsAuthentication =
                  !!current &&
                  authenticationRequired(
                    authentication,
                    current.agentId,
                    current.cwd,
                    sourceContext,
                  );
                openAgents(current?.agentId, "manage", {
                  panel: draftPreparationRequired(current)
                    ? "model"
                    : agentRepairPanel(current, needsAuthentication),
                  needsAuthentication,
                  sourceContext,
                });
              }}
              onOpened={opened}
              onRecover={recover}
              onBack={() =>
                routeHistory.current.length
                  ? returnToOrigin()
                  : showLibrary(filter)
              }
              navToggle={navToggle}
              defaultCwd={defaultCwd}
            />
          </div>
        ))}
        {hubMounted && (
          <div className="workspace-route" hidden={view.kind !== "agents"}>
            <AgentHub
              agents={agents}
              active={view.kind === "agents" && !importOpen && !paletteOpen}
              initialAgentId={hubTarget}
              initialIntent={hubIntent}
              initialView={hubView}
              requestRevision={hubRequest}
              restoredState={hubRestoredState}
              onStateChange={(state) => {
                hubSurface.current = state;
              }}
              returnLabel={
                routeHistory.current.at(-1)?.historyImport
                  ? IMPORT_STRINGS.returnToHistory
                  : routeHistory.current.at(-1)?.kind === "settings"
                    ? ACCESS_STRINGS.returnSettings
                    : routeHistory.current.at(-1)?.kind === "library"
                      ? ACCESS_STRINGS.returnLibrary
                      : ACCESS_STRINGS.returnConversation
              }
              preparationContext={hubContext}
              onReturn={returnToOrigin}
              onStart={useAgent}
              onOpenConversation={(key) => {
                rememberOrigin();
                opened(key);
              }}
              onOpenApi={() => openSettings("keys")}
              onResumeDraft={goNew}
              onCustom={(opener) => {
                customReturnFocus.current = opener;
                setCustomAgentOpen(true);
              }}
              onImport={openImport}
            />
          </div>
        )}
        {settingsMounted && (
          <SettingsPage
            active={view.kind === "settings"}
            tab={settingsTab}
            onTabChange={setSettingsTab}
            onReturn={returnToOrigin}
            onManageAgent={(agentId) => openAgents(agentId, "manage")}
            onOpenAgents={() => openAgents(undefined, "manage")}
            onResumeDraft={goNew}
            onOpenConversation={(key) => {
              rememberOrigin();
              opened(key);
            }}
            onOpenArchived={() =>
              showLibrary({
                kind: "selection",
                agent: "",
                group: "",
                favorites: false,
                state: "archived",
                query: "",
              })
            }
            initialCwd={defaultCwd}
            agents={agents}
            themeMode={themeMode}
            themeStatus={themeStatus}
            onThemeMode={setThemeMode}
          />
        )}
      </div>
      {customAgentOpen && (
        <CustomAgentDialog
          agents={agents}
          returnFocusRef={customReturnFocus}
          onClose={() => setCustomAgentOpen(false)}
          onAdded={(agentId) => {
            setCustomAgentOpen(false);
            setHubTarget(agentId);
            setHubRestoredState(undefined);
            setHubIntent("use");
            setHubView("added");
            setHubRequest((revision) => revision + 1);
            // Adding inside the directory keeps its originating draft and return path.
            // An established conversation is only a return destination for this new Agent.
            if (hubContext?.conversation) setHubContext(undefined);
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          agents={agents.cards}
          returnFocusRef={searchReturnFocus}
          onClose={() => setPaletteOpen(false)}
          onSelect={openRow}
        />
      )}
      {importMounted && (
        <ImportConversations
          agents={agents.cards}
          returnFocusRef={importReturnFocus}
          open={importOpen}
          initialAgentId={importAgent}
          requestRevision={importRequest}
          defaultCwd={defaultCwd}
          onPrepare={prepareHistoryAgent}
          onClose={() => setImportOpen(false)}
          onNew={(agentId) => {
            setImportOpen(false);
            routeHistory.current = [];
            originatingDraft.current = null;
            useAgent(
              agentId,
              newConversationChoice.agentId === agentId
                ? {
                    service: newConversationChoice.service,
                    config: { ...newConversationChoice.config },
                  }
                : undefined,
              "new-conversation",
            );
          }}
          onOpen={(row) => {
            setImportOpen(false);
            openRow(row);
          }}
        />
      )}
      {actionError && (
        <WorkspaceDialog
          title={LIBRARY.error}
          onClose={() => setActionError(null)}
        >
          <div className="workspace-dialog-body">
            <p role="alert">{actionError}</p>
          </div>
        </WorkspaceDialog>
      )}
      {pendingAgent && (
        <WorkspaceDialog
          title={LIBRARY.draftConflict}
          onClose={() => setPendingAgent(null)}
        >
          <div className="workspace-dialog-body">
            <p>{LIBRARY.draftConflictHint}</p>
          </div>
          <footer>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPendingAgent(null);
                goNew();
              }}
            >
              {LIBRARY.returnDraft}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={unreadyCandidate(pendingAgent.id)}
              onClick={() => {
                if (unreadyCandidate(pendingAgent.id)) {
                  setPendingAgent(null);
                  goNew();
                  return;
                }
                allowAutomaticConnection(pendingAgent.id);
                composerDrafts.clear("new");
                setNewAgent(pendingAgent.id);
                setPreparedSelection(pendingAgent.selection);
                setAgentRequest((n) => n + 1);
                setPendingAgent(null);
                goNew();
              }}
            >
              {LIBRARY.clearDraft}
            </button>
          </footer>
        </WorkspaceDialog>
      )}
    </div>
  );
}
