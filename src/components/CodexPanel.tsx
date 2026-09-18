import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  codexConversation,
  type CodexConversation,
} from "../runtime/codex-conversation";
import {
  codexAcpObservedEvent,
  codexWorkspaceView,
  type CodexObservedEvent,
} from "../runtime/codex-workspace-view";
import { codexAcpWorkspaceLabel } from "../runtime/codex-acp-workspace";
import {
  codexBindingKey,
  codexWorkspaceBackend,
  CodexViewLifetime,
  RetiredCodexView,
} from "../runtime/codex-workspace-backend";
import { useCodexAcpWorkspace } from "../runtime/use-codex-acp-workspace";
import { useHostSessionDraft } from "../runtime/host-draft";
import {
  focusHostSession,
  updateHostSessionMetadata,
} from "../runtime/host-session-metadata";
import {
  subscribeHostRuntimeEvents,
  subscribeHostShadowState,
  type HostPendingInteraction,
  type HostSessionBinding,
} from "../runtime/host-shadow";
import {
  appendProjectReferences,
  projectFileReferences,
} from "../runtime/project-file-reference";
import { useSessionFocus } from "../runtime/use-session-focus";
import type { RuntimePanelProps } from "../runtime/workspace-contract";
import { CommandPalette } from "./CommandPalette";
import { Composer } from "./Composer";
import { CodexAcpSessionStart } from "./CodexAcpSessionStart";
import { CodexConnectionPanel } from "./CodexConnectionPanel";
import { CodexInteractionPanel } from "./CodexInteractionPanel";
import { CodexTranscript } from "./CodexTranscript";
import { LifeModelPanel } from "./LifeModelPanel";
import { RuntimeChooser } from "./RuntimeChooser";
import { SessionContextPanel } from "./SessionContextPanel";
import type { SidebarSessionItem } from "./Sidebar";
import { WorkingCopyManagerDialog } from "./WorkingCopyManagerDialog";
import { WorkspaceError } from "./WorkspaceError";
import { WorkspaceHeader } from "./WorkspaceHeader";

// Codex ACP Runtime panel for the unified Workspace shell. All work goes
// through the owned Codex ACP adapter: Connect derives the owned profile from
// the registered installation and Working Copy; Session/Turn/Interact/Steer
// dispatch through the typed facade. Nothing falls back to the old Direct
// transport, and unknown results keep their original identity.
export function CodexPanel({
  active,
  initialProjectPath,
  requestedHostSessionId,
  requestedHostSession,
  onRequestedHostSessionHandled,
  restoredHostSession,
  onProjectPath,
  onSelectRuntime,
  themeMode,
  onThemeMode,
  onOpenUpdate,
  lifeModel,
  notice,
  shellActions,
  onShellMeta,
}: RuntimePanelProps) {
  const [project, setProject] = useState(initialProjectPath);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activatedId, setActivatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [commands, setCommands] = useState(false);
  const [workingCopiesOpen, setWorkingCopiesOpen] = useState(false);
  const [hostSessions, setHostSessions] = useState<HostSessionBinding[]>([]);
  const [hostPendingInteractions, setHostPendingInteractions] = useState<
    HostPendingInteraction[]
  >([]);
  const [observed, setObserved] = useState<{
    key: string;
    events: CodexObservedEvent[];
  }>({ key: "", events: [] });
  const ticket = useRef(0);
  const lifetime = useRef(new CodexViewLifetime());
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const restored = useRef(false);

  const codexSessions = hostSessions.filter(
    (session) => session.runtimeProductId === "codex",
  );
  const binding =
    codexSessions.find(
      (session) => session.farfoldSessionId === sessionId,
    ) ?? null;
  const boundKey = codexBindingKey(binding);
  const bindingRef = useRef(boundKey);
  bindingRef.current = boundKey;
  const acp = useCodexAcpWorkspace(active, binding);
  // The hook already keys its result to the current binding identity.
  const snapshot = acp?.snapshot ?? null;
  const scope = snapshot?.scope ?? null;
  const connected = snapshot?.connectionState === "connected";
  const opened =
    activatedId === binding?.farfoldSessionId || !!snapshot?.target;
  const working = !!snapshot?.activeTurn;
  const viewKey = JSON.stringify([boundKey, active, scope]);
  const selectedCurrent = lifetime.current.select(viewKey);
  const current = () => mounted.current && activeRef.current && selectedCurrent();
  const backend = codexWorkspaceBackend(
    binding,
    current,
    undefined,
    scope,
  );
  const conversation: CodexConversation = codexConversation();
  const view = codexWorkspaceView({
    binding,
    opened: null,
    status: null,
    conversation,
    acp: snapshot,
    acpTranscript: acp?.transcript ?? null,
    pending: hostPendingInteractions,
    observed: observed.key === viewKey ? observed.events : [],
  });
  const path = binding?.workingCopyPath ?? project;
  const activeTurn = snapshot?.activeTurn ?? null;
  const canSteer =
    view.capabilities.steer && !!activeTurn?.nativeTurnId && !submitting;
  const acpStatus =
    acp?.error ??
    (snapshot ? codexAcpWorkspaceLabel(snapshot) : "Codex ACP 状态尚未核对");

  const [draft, setDraft] = useHostSessionDraft(sessionId, (reason) =>
    setError(String(reason)),
  );
  const draftRef = useRef({ sessionId, draft });
  draftRef.current = { sessionId, draft };
  useSessionFocus(active, sessionId, requestedHostSessionId, setError);

  useLayoutEffect(() => {
    if (following.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [acp?.transcript, view.interactions.length, snapshot?.activeTurn]);

  useEffect(() => {
    mounted.current = true;
    const stop = subscribeHostShadowState((state) => {
      setHostSessions(state.navigation.sessionIndex.sessions);
      setHostPendingInteractions(state.pendingInteractions);
    });
    return () => {
      mounted.current = false;
      ++ticket.current;
      stop();
    };
  }, []);

  useEffect(() => {
    if (!active) {
      ++ticket.current;
      setBusy(false);
      setSubmitting(false);
    }
  }, [active]);

  useEffect(() => {
    if (restored.current || !hostSessions.length) return;
    restored.current = true;
    const last = restoredHostSession;
    if (last && last.runtimeProductId === "codex") {
      setSessionId(last.farfoldSessionId);
      setProject(last.workingCopyPath);
    }
  }, [hostSessions, restoredHostSession]);

  useEffect(() => {
    if (!active || !snapshot) return;
    const snap = snapshot;
    return subscribeHostRuntimeEvents((event) => {
      if (!current()) return;
      const observation = codexAcpObservedEvent(event, snap);
      if (!observation) return;
      setObserved((previous) => {
        const events = previous.key === viewKey ? previous.events : [];
        if (events.some((e) => e.sequence >= observation.sequence))
          return previous;
        return { key: viewKey, events: [...events.slice(-63), observation] };
      });
    });
  }, [active, viewKey, snapshot]);

  useEffect(() => {
    if (!active || !requestedHostSessionId) return;
    const id = requestedHostSessionId;
    const requested =
      requestedHostSession ??
      codexSessions.find((session) => session.farfoldSessionId === id) ??
      null;
    if (!requested || requested.runtimeProductId !== "codex") return;
    onRequestedHostSessionHandled(id);
    if (sessionId === id && opened && connected) {
      void focusHostSession(id).catch((reason) => setError(String(reason)));
      return;
    }
    if (working && sessionId !== id) {
      setError("当前 Codex 任务尚未结束；请先处理当前任务，再打开另一条原生会话。");
      return;
    }
    ++ticket.current;
    setSessionId(id);
    setActivatedId(null);
    setProject(requested.workingCopyPath);
    onProjectPath(requested.workingCopyPath);
    setBusy(false);
    setError(null);
  }, [
    active,
    requestedHostSessionId,
    requestedHostSession,
    codexSessions,
    sessionId,
    opened,
    connected,
    working,
    onRequestedHostSessionHandled,
    onProjectPath,
  ]);

  async function chooseProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Codex Working Copy",
    });
    if (typeof selected === "string") {
      lifetime.current.retire();
      ++ticket.current;
      setProject(selected);
      onProjectPath(selected);
    }
  }

  function newSession() {
    if (working || submitting) return;
    ++ticket.current;
    setBusy(false);
    setSessionId(null);
    setActivatedId(null);
    setError(null);
  }

  async function metadata(
    item: SidebarSessionItem,
    changes: { pinned?: boolean; archived?: boolean },
  ) {
    await updateHostSessionMetadata({
      farfoldSessionId: item.key,
      ...changes,
    });
    if (changes.archived && item.key === sessionId) newSession();
  }

  async function referenceFiles() {
    if (!binding || busy || submitting) return;
    const origin = draftRef.current;
    const currentTicket = ++ticket.current;
    setBusy(true);
    setError(null);
    try {
      const selected = await open({
        title: "引用当前项目文件（仅添加路径）",
        defaultPath: binding.workingCopyPath,
        multiple: true,
        directory: false,
      });
      if (!selected) return;
      const references = await projectFileReferences(
        binding.farfoldSessionId,
        binding.nativeSessionId,
        Array.isArray(selected) ? selected : [selected],
      );
      if (
        currentTicket !== ticket.current ||
        draftRef.current.sessionId !== origin.sessionId ||
        draftRef.current.draft !== origin.draft
      )
        throw new Error("会话或草稿已变化，请在当前草稿中重新选择文件。");
      setDraft(appendProjectReferences(origin.draft, references));
    } catch (reason) {
      if (currentTicket === ticket.current && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    } finally {
      if (currentTicket === ticket.current) setBusy(false);
    }
  }

  async function send() {
    if (
      !binding ||
      !scope ||
      !snapshot ||
      submitting ||
      !draft.trim() ||
      (!view.capabilities.send && !canSteer)
    )
      return;
    const text = draft;
    following.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (canSteer && activeTurn?.nativeTurnId) {
        await backend.steerAcp(
          scope,
          activeTurn.context,
          activeTurn.nativeTurnId,
          `steer-${crypto.randomUUID()}`,
          text,
        );
      } else {
        await backend.turnAcp(scope, {
          action: "send",
          farfoldSessionId: binding.farfoldSessionId,
          text,
        });
      }
      if (
        draftRef.current.sessionId === binding.farfoldSessionId &&
        draftRef.current.draft === text
      )
        setDraft("");
    } catch (reason) {
      if (backend.current() && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    } finally {
      if (backend.current()) setSubmitting(false);
    }
  }

  async function abort() {
    if (
      !binding ||
      !scope ||
      !view.capabilities.stop ||
      !activeTurn?.nativeTurnId
    )
      return;
    try {
      await backend.turnAcp(scope, {
        action: "interrupt",
        farfoldSessionId: binding.farfoldSessionId,
        hostTurnId: activeTurn.context.hostTurnId,
        nativeTurnId: activeTurn.nativeTurnId,
      });
    } catch (reason) {
      if (backend.current() && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    }
  }

  async function disconnect() {
    if (!scope || busy || working || submitting) return;
    const currentTicket = ++ticket.current;
    setBusy(true);
    setError(null);
    try {
      await backend.stopAcp(scope);
      if (currentTicket === ticket.current) setActivatedId(null);
    } catch (reason) {
      if (currentTicket === ticket.current && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    } finally {
      if (currentTicket === ticket.current) setBusy(false);
    }
  }

  const shellBusy = busy || submitting;
  useEffect(() => {
    onShellMeta({
      activeSessionKey: sessionId,
      busy: shellBusy,
      working,
      providerCount:
        snapshot?.admission?.account &&
        snapshot.admission.account.kind !== "unauthenticated"
          ? 1
          : 0,
      settingsTitle: "Codex 程序与账号",
      settingsSubtitle: connected ? "自有连接已就绪" : "自有连接未建立",
      contextOpen: details,
    });
  }, [
    onShellMeta,
    sessionId,
    shellBusy,
    working,
    snapshot?.admission?.account,
    connected,
    details,
  ]);
  useEffect(() => {
    const actions = shellActions.current;
    actions.newSession = () => newSession();
    actions.openConnections = () => setDetails((current) => !current);
    actions.togglePinned = (item) =>
      void metadata(item, { pinned: !item.pinned }).catch((reason) =>
        setError(String(reason)),
      );
    actions.archive = (item) => metadata(item, { archived: true });
    actions.restore = (item) => metadata(item, { archived: false });
  });
  useEffect(() => {
    const actions = shellActions.current;
    return () => {
      actions.newSession = undefined;
      actions.openConnections = undefined;
      actions.togglePinned = undefined;
      actions.archive = undefined;
      actions.restore = undefined;
    };
  }, [shellActions]);

  if (!active) return null;

  return (
    <>
      <WorkspaceHeader
        session={{
          sessionId: sessionId ?? undefined,
          title: binding?.title ?? "Codex",
          disabled: shellBusy,
          onError: setError,
        }}
        modelControls={<span>{view.modelLabel}</span>}
        runtimeControls={
          <RuntimeChooser
            value="codex"
            disabled={shellBusy}
            running={connected}
            providerStatus="以原生请求结果为准"
            lifeModelEnabled={lifeModel.snapshot?.enabled ?? false}
            onChange={onSelectRuntime}
          />
        }
        lifeModelCount={lifeModel.snapshot?.items.length ?? 0}
        onOpenLifeModel={lifeModel.onOpen}
        projectPath={path}
        projectLabel={path?.split("/").at(-1) ?? "选择项目"}
        onChooseProject={() => void chooseProject()}
        projectLocked={shellBusy || !!binding}
        runtimeStatus={
          working
            ? activeTurn?.stopRequested
              ? "已请求停止，等待原生终态"
              : activeTurn?.nativeTurnId
                ? "原生轮次活动中"
                : "提交结果待确认"
            : busy
              ? "正在核对自有环境"
              : acpStatus
        }
        working={working}
        contextOpen={details}
        onToggleContext={() => setDetails((current) => !current)}
        onOpenCommands={() => setCommands(true)}
      />
      <div className="runtime-notices">
        {error && (
          <WorkspaceError message={error} onClose={() => setError(null)} />
        )}
        {notice && <WorkspaceError {...notice} />}
      </div>
      <div
        className="conversation-scroll"
        ref={transcript}
        onScroll={() => {
          const node = transcript.current;
          if (node)
            following.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {!opened ? (
          <CodexAcpSessionStart
            key={JSON.stringify([boundKey, path, scope])}
            binding={binding}
            projectPath={path}
            chooseProject={() => void chooseProject()}
            allowed={!shellBusy}
            snapshot={snapshot}
            connect={(installationId, workingCopyId) =>
              backend.connectAcp(installationId, workingCopyId)
            }
            current={current}
            onActivated={(registered) => {
              if (!current()) return;
              ++ticket.current;
              setSessionId(registered.farfoldSessionId);
              setActivatedId(registered.farfoldSessionId);
              setProject(registered.workingCopyPath);
              onProjectPath(registered.workingCopyPath);
              setError(null);
              following.current = true;
            }}
          >
            <p role="status">{acpStatus}</p>
            <CodexConnectionPanel
              acp={{
                scope,
                viewKey,
                port: {
                  allowed: snapshot?.capabilities.authenticate ?? false,
                  current,
                  request: (s, command) => backend.configureAcp(s, command),
                  discover: (s) => backend.discoverConfigureAcp(s),
                },
              }}
            />
          </CodexAcpSessionStart>
        ) : view.acpTranscript && view.acpTranscript.turns.length > 0 ? (
          <CodexTranscript
            conversation={conversation}
            acp={view.acpTranscript}
            session={binding}
            summary={view.acpTranscript.notice ?? view.historySummary}
          />
        ) : (
          <div className="empty-conversation">
            <span className="brand-letter">F</span>
            <h2>开始 Codex 任务</h2>
            <p>支持文本任务、审批、转向与停止；任务结果以原生确认为准。</p>
            {snapshot?.target && <p>{snapshot.target.nativeThreadId}</p>}
          </div>
        )}
        {binding &&
          view.interactions.map((interaction) => (
            <CodexInteractionPanel
              key={interaction.key}
              interaction={interaction}
              turns={conversation.turns}
              onReply={(answer) => {
                if (!scope) return Promise.resolve();
                return backend.interactAcp(
                  scope,
                  interaction.pending.interactionId,
                  answer,
                );
              }}
              enabled={
                view.capabilities.reply &&
                !!activeTurn?.nativeTurnId &&
                interaction.request.turnId === activeTurn.nativeTurnId
              }
            />
          ))}
        {snapshot?.connectionState === "unknown" && (
          <div role="alert">
            <p>结果尚未确认。工作目录保持占用，输入不会自动重发。</p>
            {scope && !working && (
              <button onClick={() => void disconnect()}>
                停止自有 Codex 连接并核对
              </button>
            )}
          </div>
        )}
        {details && (
          <details open>
            <summary>Codex 会话详情</summary>
            <p>{binding?.nativeSessionId ?? "尚未绑定"}</p>
            <p>{path}</p>
            <CodexConnectionPanel
              acp={{
                scope,
                viewKey: `${viewKey}-details`,
                port: {
                  allowed: snapshot?.capabilities.authenticate ?? false,
                  current,
                  request: (s, command) => backend.configureAcp(s, command),
                  discover: (s) => backend.discoverConfigureAcp(s),
                },
              }}
            />
            <p>LifeModel 来源与消费尚未接入。</p>
          </details>
        )}
      </div>
      <Composer
        runtimeLabel="Codex"
        supportsSteering={view.capabilities.steer}
        supportsFollowUp={false}
        steeringHint="发送到当前原生轮次，由 Codex 应用"
        running={opened}
        ready={
          connected &&
          (view.capabilities.send || canSteer) &&
          !shellBusy &&
          !activeTurn?.stopRequested
        }
        draftEditable={!!sessionId}
        notReadyReason={
          !connected
            ? "请先连接自有环境并打开原生会话"
            : activeTurn?.stopRequested
              ? "已请求停止，等待原生终态"
              : working
                ? "当前任务尚未结束，输入可保留"
                : "模型与实际会话未确认，不能发送"
        }
        working={working}
        submitting={shellBusy}
        stopping={!!activeTurn?.stopRequested}
        message={draft}
        delivery="steer"
        projectName={path?.split("/").at(-1) ?? "未选择项目"}
        contextPercent={null}
        commands={[]}
        lifeModelItems={[]}
        onMessage={setDraft}
        onDelivery={() => undefined}
        onSend={() => void send()}
        onAbort={() => void abort()}
        onRemoveLifeModelItem={() => undefined}
        onOpenLifeModel={lifeModel.onOpen}
        onReferenceFiles={binding ? () => void referenceFiles() : undefined}
      />
      {details && binding && (
        <SessionContextPanel
          session={binding}
          lifeModelItemCount={lifeModel.snapshot?.items.length ?? 0}
          onOpenLifeModel={lifeModel.onOpen}
          onCreateSessionInWorktree={async () => {
            setError("Codex 会话不支持托管 worktree 新建");
          }}
          onManageWorkingCopies={() => setWorkingCopiesOpen(true)}
          onClose={() => setDetails(false)}
        />
      )}
      {workingCopiesOpen && (
        <WorkingCopyManagerDialog onClose={() => setWorkingCopiesOpen(false)} />
      )}
      <CommandPalette
        open={commands}
        themeMode={themeMode}
        onThemeMode={onThemeMode}
        onOpen={() => setCommands(true)}
        onClose={() => setCommands(false)}
        items={[
          {
            id: "codex-disconnect",
            label: "停止自有 Codex 连接",
            description: "停止当前自有环境连接；不会自动重连",
            onSelect: () => void disconnect(),
          },
          {
            id: "updates",
            label: "检查应用更新",
            description: "打开更新与恢复",
            onSelect: onOpenUpdate,
          },
        ]}
      />
      {lifeModel.open && <LifeModelPanel {...lifeModel} />}
    </>
  );
}
