import { CodexInteractionPanel } from "./CodexInteractionPanel";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  catalogMatchesConnection,
  type CodexConnectionStatus,
  type CodexModelCatalog,
} from "../runtime/codex-connection";
import { useHostSessionDraft } from "../runtime/host-draft";
import {
  focusHostSession,
  updateHostSessionMetadata,
} from "../runtime/host-session-metadata";
import { useSessionFocus } from "../runtime/use-session-focus";
import {
  appendProjectReferences,
  projectFileReferences,
} from "../runtime/project-file-reference";
import {
  subscribeHostRuntimeEvents,
  type HostSessionOpenResult,
} from "../runtime/host-shadow";
import { sessionStartInput } from "../runtime/session-start";
import type { HostWorkspaceChannel } from "../runtime/use-host-workspace";
import type { RuntimeWorkspaceProps } from "../runtime/workspace-contract";
import {
  applyCodexEvent,
  codexEventMatchesScope,
  codexBusy,
  codexConversation,
  type CodexConversation,
} from "../runtime/codex-conversation";
import {
  codexWorkspaceBackend,
  codexBindingKey,
  CodexViewLifetime,
  RetiredCodexView,
} from "../runtime/codex-workspace-backend";
import {
  codexWorkspaceView,
  codexAcpObservedEvent,
  type CodexObservedEvent,
} from "../runtime/codex-workspace-view";
import { CodexTranscript } from "./CodexTranscript";
import { CodexInstallationDialog } from "./CodexInstallationDialog";
import { CodexConnectionPanel } from "./CodexConnectionPanel";
import { CodexAcpSessionStart } from "./CodexAcpSessionStart";
import { CodexModelFields } from "./CodexModelFields";
import { CommandPalette } from "./CommandPalette";
import { Composer } from "./Composer";
import { LifeModelPanel } from "./LifeModelPanel";
import { RuntimeChooser } from "./RuntimeChooser";
import { SessionDeletionDialog } from "./SessionDeletionDialog";
import { SessionStartPanel } from "./SessionStartPanel";
import { Sidebar, type SidebarSessionItem } from "./Sidebar";
import { sidebarSessionsFromHost } from "./sidebar-sessions";
import { WorkspaceError } from "./WorkspaceError";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { traceAfterPaint } from "../runtime/performance-trace";
import { runtimeEnvelopeFromHostEvent } from "../runtime/host-shadow";
import { codexWorkspaceRoute } from "../runtime/codex-workspace-route";
import { useCodexAcpWorkspace } from "../runtime/use-codex-acp-workspace";
import {
  CODEX_ACP_CLOSED_REASON,
  codexAcpWorkspaceLabel,
} from "../runtime/codex-acp-workspace";

export function CodexWorkspace(
  props: RuntimeWorkspaceProps & { hostChannel: HostWorkspaceChannel },
) {
  const { active, hostChannel, lifeModel } = props;
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null);
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null);
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<"default" | "plan">("default");
  const [effort, setEffort] = useState("");
  const [configureRevision, setConfigureRevision] = useState(0);
  const [project, setProject] = useState(props.initialProjectPath);
  const [sessionId, setSessionId] = useState<string | null>(null);
  useSessionFocus(
    active,
    sessionId,
    props.requestedHostSessionId,
    setFocusError,
  );
  function setFocusError(message: string) {
    setError(message);
  }
  const [opened, setOpened] = useState<HostSessionOpenResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [conversation, setConversation] = useState<CodexConversation>(() =>
    codexConversation(),
  );
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [details, setDetails] = useState(false);
  const [commands, setCommands] = useState(false);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<SidebarSessionItem | null>(null);
  const ticket = useRef(0);
  const lifetime = useRef(new CodexViewLifetime());
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [observed, setObserved] = useState<{
    key: string;
    events: CodexObservedEvent[];
  }>({ key: "", events: [] });
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const restored = useRef(false);
  const sessions = hostChannel.state?.navigation.sessionIndex.sessions ?? [];
  const binding =
    sessions.find((s) => s.farfoldSessionId === sessionId) ?? null;
  const route = codexWorkspaceRoute(binding);
  const boundKey = codexBindingKey(binding);
  const bindingRef = useRef(boundKey);
  bindingRef.current = boundKey;
  const direct = route === "direct";
  const acp = useCodexAcpWorkspace(active && route === "acp", binding);
  useLayoutEffect(() => {
    if (following.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [conversation, acp?.transcript]);
  const viewKey = JSON.stringify([
    codexBindingKey(binding),
    active,
    opened?.runtimeGeneration,
    acp?.snapshot?.scope,
  ]);
  const selectedCurrent = lifetime.current.select(viewKey);
  const current = () => mounted.current && active && selectedCurrent();
  const backend = codexWorkspaceBackend(
    binding,
    current,
    opened
      ? {
          generation: opened.runtimeGeneration,
          activeTurnId: conversation.nativeTurnId,
        }
      : undefined,
    acp?.snapshot?.connectionState === "connected" ? acp.snapshot.scope : null,
  );
  const view = codexWorkspaceView({
    binding,
    opened,
    status,
    conversation,
    acp: acp?.snapshot ?? null,
    acpTranscript: acp?.transcript,
    pending: hostChannel.state?.pendingInteractions ?? [],
    observed: observed.key === viewKey ? observed.events : [],
  });
  const closedReason =
    route === "unsupported"
      ? "此会话的 Adapter 尚不受支持；不会改用其他连接。"
      : CODEX_ACP_CLOSED_REASON;
  const acpStatus =
    acp?.error ??
    (acp?.snapshot
      ? codexAcpWorkspaceLabel(acp.snapshot)
      : "Codex ACP 状态尚未核对");
  const [draft, setDraft] = useHostSessionDraft(sessionId, (reason) =>
    setError(String(reason)),
  );
  const validCatalog =
    catalog && catalogMatchesConnection(catalog, status) ? catalog : null;
  const model = validCatalog?.models.find((m) => m.id === modelId);
  const native = view.native;
  const path = binding?.workingCopyPath ?? project;
  const working = codexBusy(conversation.phase);
  const canSteer =
    conversation.phase === "executing" && !!conversation.nativeTurnId;
  const pending = view.interactions;
  const draftRef = useRef({ sessionId, draft });
  draftRef.current = { sessionId, draft };
  const connected = view.connected;
  useEffect(() => {
    if (!active || route !== "acp" || !acp?.snapshot) return;
    const snapshot = acp.snapshot;
    return subscribeHostRuntimeEvents((event) => {
      if (!current()) return;
      const observation = codexAcpObservedEvent(event, snapshot);
      if (!observation) return;
      setObserved((previous) => {
        const events = previous.key === viewKey ? previous.events : [];
        if (events.some((e) => e.sequence >= observation.sequence))
          return previous;
        return { key: viewKey, events: [...events.slice(-63), observation] };
      });
    });
  }, [active, route, viewKey, acp?.snapshot]);
  useEffect(() => {
    if (!direct || !binding || !opened) return;
    const scope = {
      installationId: binding.installationId,
      runtimeBuildId: binding.runtimeBuildId,
      connectionId: binding.connectionId,
      generation: opened.runtimeGeneration,
      nativeSessionId: binding.nativeSessionId,
    };
    return subscribeHostRuntimeEvents((event) => {
      if (bindingRef.current !== boundKey) return;
      if (!codexEventMatchesScope(event, scope)) return;
      setConversation((previous) => applyCodexEvent(previous, event, scope));
      const payload = runtimeEnvelopeFromHostEvent(event)?.payload as
        { method?: string; params?: { threadId?: string } } | undefined;
      if (
        event.kind === "codex_rpc" &&
        payload?.method === "item/agentMessage/delta" &&
        payload.params?.threadId === scope.nativeSessionId
      )
        traceAfterPaint("codex_event_paint", event.receivedAtMs);
    });
  }, [direct, binding?.farfoldSessionId, opened]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++ticket.current;
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
    if (restored.current || !hostChannel.state) return;
    restored.current = true;
    const last = sessions.find(
      (s) =>
        s.farfoldSessionId ===
          hostChannel.state?.navigation.restoreState?.lastSessionId &&
        s.runtimeProductId === "codex",
    );
    if (last) {
      setSessionId(last.farfoldSessionId);
      setProject(last.workingCopyPath);
    }
  }, [hostChannel.state]);

  useEffect(() => {
    if (!direct || !active || busy || settings) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await backend.read();
        if (result.kind !== "direct") return;
        const next = result.status;
        if (!canceled) {
          setStatus(next);
          if (
            opened &&
            (!next.initialized || opened.runtimeGeneration !== next.generation)
          )
            setConversation((previous) =>
              codexBusy(previous.phase)
                ? { ...previous, phase: "unknown" }
                : previous,
            );
          timer = setTimeout(() => void refresh(), 2000);
        }
      } catch (reason) {
        if (!canceled && !(reason instanceof RetiredCodexView))
          setError(String(reason));
      }
    }
    void refresh();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [direct, active, busy, settings, opened, viewKey]);

  async function operation(action: (current: number) => Promise<void>) {
    const current = ++ticket.current;
    setBusy(true);
    setError(null);
    try {
      await action(current);
    } catch (reason) {
      if (current === ticket.current && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    } finally {
      if (current === ticket.current) setBusy(false);
    }
  }

  function adopt(result: HostSessionOpenResult, current: number) {
    if (current !== ticket.current || !mounted.current || !activeRef.current)
      return;
    if (
      result.runtimeProductId !== "codex" ||
      codexWorkspaceRoute(
        result.navigation.sessionIndex.sessions.find(
          (session) => session.farfoldSessionId === result.farfoldSessionId,
        ) ?? null,
      ) !== "direct" ||
      !result.codex ||
      result.nativeSessionId !== result.codex.thread.id
    )
      throw new Error("Host 与 Codex 原生会话身份不一致");
    setSessionId(result.farfoldSessionId);
    setOpened(result);
    following.current = true;
    setConversation(codexConversation(result.codex.thread.turns));
    setProject(result.codex.cwd);
    props.onProjectPath(result.codex.cwd);
  }

  async function resume(id: string) {
    if (opened?.farfoldSessionId === id && connected) {
      try {
        await focusHostSession(id);
      } catch (reason) {
        setError(String(reason));
      }
      return;
    }
    if (working || submitting) {
      setError(
        "当前 Codex 任务尚未结束；请先处理当前任务，再打开另一条原生会话。",
      );
      return;
    }
    const saved = sessions.find((session) => session.farfoldSessionId === id);
    if (!saved) {
      setError("尚未读取此会话的原始绑定，不能选择连接。");
      return;
    }
    ++ticket.current;
    setSessionId(id);
    setOpened(null);
    setConversation(codexConversation());
    setBusy(false);
    setSettings(false);
    setError(null);
    if (codexWorkspaceRoute(saved) !== "direct") return;
    await operation(async (current) => {
      const result = await codexWorkspaceBackend(
        saved,
        () =>
          mounted.current && activeRef.current && current === ticket.current,
      ).open();
      if (current !== ticket.current) return;
      if (result.farfoldSessionId !== id)
        throw new Error("Host 返回了另一条会话");
      adopt(result, current);
      traceAfterPaint("codex_resume", result.runtimeReadyAt);
    });
  }

  async function referenceFiles() {
    if (!binding || busy || submitting) return;
    const origin = draftRef.current;
    await operation(async () => {
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
        draftRef.current.sessionId !== origin.sessionId ||
        draftRef.current.draft !== origin.draft
      )
        throw new Error("会话或草稿已变化，请在当前草稿中重新选择文件。");
      setDraft(appendProjectReferences(origin.draft, references));
    });
  }

  useEffect(() => {
    if (
      !active ||
      !props.requestedHostSessionId ||
      props.requestedHostSession?.runtimeProductId !== "codex"
    )
      return;
    const id = props.requestedHostSessionId;
    props.onRequestedHostSessionHandled();
    void resume(id);
  }, [active, props.requestedHostSessionId, props.requestedHostSession]);

  function newSession() {
    if (working || submitting) return;
    ++ticket.current;
    setBusy(false);
    setSettings(false);
    setConversation(codexConversation());
    restored.current = true;
    setSessionId(null);
    setOpened(null);
    setError(null);
  }
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
      props.onProjectPath(selected);
    }
  }
  async function create() {
    if (
      !direct ||
      !status?.installationId ||
      !status.connectionId ||
      status.generation === null ||
      !model ||
      !effort ||
      !path
    )
      return;
    const input = sessionStartInput(
      path,
      {
        runtimeProductId: "codex",
        generation: status.generation,
        catalogModelId: model.id,
        reasoningEffort: effort,
      },
      {
        installationId: status.installationId,
        connectionId: status.connectionId,
      },
    );
    await operation(async (current) =>
      adopt(await backend.create(input), current),
    );
  }
  async function metadata(
    item: SidebarSessionItem,
    changes: { pinned?: boolean; archived?: boolean },
  ) {
    await operation(async () => {
      await updateHostSessionMetadata({
        farfoldSessionId: item.key,
        ...changes,
      });
      if (changes.archived && item.key === sessionId) newSession();
    });
  }
  async function send() {
    if (
      !direct ||
      !binding ||
      !opened ||
      !connected ||
      (working && !canSteer) ||
      submitting ||
      !draft.trim()
    )
      return;
    const text = draft;
    following.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const target = {
        farfoldSessionId: binding.farfoldSessionId,
        nativeSessionId: binding.nativeSessionId,
        generation: opened.runtimeGeneration,
      };
      const result =
        canSteer && conversation.nativeTurnId
          ? await backend.steer(target, conversation.nativeTurnId, text)
          : await backend.submit(target, text, mode);
      if (result.outcome === "accepted") {
        if (
          draftRef.current.sessionId === target.farfoldSessionId &&
          draftRef.current.draft === text
        )
          setDraft("");
      } else setError(result.detail);
    } catch (reason) {
      if (backend.current() && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    } finally {
      if (backend.current()) setSubmitting(false);
    }
  }
  async function stopOwned() {
    if (!direct || !status) return;
    try {
      setStatus(await backend.disconnect(status));
      setOpened(null);
    } catch (reason) {
      if (backend.current() && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    }
  }
  async function abort() {
    if (!direct || !binding || !opened) return;
    if (!conversation.nativeTurnId) {
      await stopOwned();
      return;
    }
    try {
      await backend.interrupt(
        {
          farfoldSessionId: binding.farfoldSessionId,
          nativeSessionId: binding.nativeSessionId,
          generation: opened.runtimeGeneration,
        },
        conversation.nativeTurnId,
      );
    } catch (reason) {
      if (backend.current() && !(reason instanceof RetiredCodexView))
        setError(String(reason));
    }
  }
  if (!active) return null;
  return (
    <div className="app-shell">
      <Sidebar
        sessions={sidebarSessionsFromHost(
          sessions,
          hostChannel.state?.pendingInteractions,
        )}
        activeSessionKey={sessionId}
        search={search}
        disabled={busy}
        isSessionSelectionDisabled={(item) =>
          busy ||
          (working &&
            item.runtimeProductId === "codex" &&
            item.key !== sessionId)
        }
        configuredProviderCount={direct && status?.account?.account ? 1 : 0}
        attentionCount={hostChannel.state?.pendingInteractions.length ?? 0}
        settingsTitle="Codex 程序与账号"
        settingsSubtitle={
          direct
            ? status?.initialized
              ? "连接已就绪"
              : "检查连接"
            : "ACP 入口暂未开放"
        }
        onSearch={setSearch}
        onNew={newSession}
        newDisabled={working || submitting}
        onSelect={(item) =>
          item.runtimeProductId === "codex"
            ? void resume(item.key)
            : props.onSelectHostSession(item)
        }
        onTogglePinned={(item) => void metadata(item, { pinned: !item.pinned })}
        onArchive={(item) => metadata(item, { archived: true })}
        onRestore={(item) => metadata(item, { archived: false })}
        onDelete={setDeleting}
        onOpenConnections={() =>
          direct ? setSettings(true) : setError(closedReason)
        }
      />
      <main className="workspace">
        <WorkspaceHeader
          session={{
            sessionId: sessionId ?? undefined,
            title: binding?.title ?? "Codex",
            disabled: busy,
            onError: setError,
          }}
          modelControls={<span>{view.modelLabel}</span>}
          runtimeControls={
            <RuntimeChooser
              value="codex"
              disabled={busy || submitting}
              running={direct && (status?.processRunning ?? false)}
              providerStatus="以原生请求结果为准"
              lifeModelEnabled={lifeModel.snapshot?.enabled ?? false}
              onChange={props.onSelectRuntime}
            />
          }
          lifeModelCount={lifeModel.snapshot?.items.length ?? 0}
          onOpenLifeModel={lifeModel.onOpen}
          projectPath={path}
          projectLabel={path?.split("/").at(-1) ?? "选择项目"}
          onChooseProject={() => void chooseProject()}
          projectLocked={busy || !!binding}
          runtimeStatus={
            !direct
              ? acpStatus
              : busy
                ? "正在核对原生会话"
                : status?.initialized
                  ? pending.length && conversation.phase === "executing"
                    ? "等待用户处理"
                    : {
                        idle: "Codex 连接已就绪",
                        submitting: "提交中",
                        executing: "执行中",
                        stopping: "停止中，等待原生确认",
                        completed: "原生轮次结束，请核对成果",
                        failed: "原生任务失败",
                        interrupted: "已中断",
                        rejected: "请求被拒绝，输入已保留",
                        unknown: "结果未知，需要核对",
                      }[conversation.phase]
                  : "Codex 未连接"
          }
          working={working}
          contextOpen={details}
          onToggleContext={() => setDetails(!details)}
          onOpenCommands={() => setCommands(true)}
        />
        <div className="runtime-notices">
          {error && (
            <WorkspaceError message={error} onClose={() => setError(null)} />
          )}
          {props.notice && <WorkspaceError {...props.notice} />}
          {native && (
            <label className="codex-mode">
              下一轮模式{" "}
              <select
                value={mode}
                disabled={working || submitting || busy}
                onChange={(e) => setMode(e.target.value as "default" | "plan")}
              >
                <option value="default">工作</option>
                <option value="plan">Plan（可原生提问）</option>
              </select>
            </label>
          )}
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
          {native && native.thread.turns.length > 0 && (
            <p className="inline-warning">
              此处显示 Codex 官方接口可恢复的历史。0.143.0
              冷启动后可能不返回命令执行详情；不能据此判断先前未执行命令。
            </p>
          )}
          {!native && route === "acp" ? (
            <CodexAcpSessionStart
              key={JSON.stringify([
                boundKey,
                path,
                active,
                configureRevision,
                acp?.snapshot?.scope,
              ])}
              binding={binding}
              projectPath={path}
              chooseProject={() => void chooseProject()}
              allowed={backend.capabilities.open}
              current={backend.current}
              onActivated={(registered) => {
                if (!backend.current()) return;
                ++ticket.current;
                setSessionId(registered.farfoldSessionId);
                setProject(registered.workingCopyPath);
                props.onProjectPath(registered.workingCopyPath);
                setOpened(null);
                setConversation(codexConversation());
                setError(null);
              }}
            >
              <p role="status">{acpStatus}</p>
              <CodexConnectionPanel
                acp={{
                  scope:
                    acp?.snapshot?.connectionState === "connected"
                      ? acp.snapshot.scope
                      : null,
                  viewKey,
                  port: {
                    allowed: backend.capabilities.configure,
                    current: backend.current,
                    request: (scope, command) => {
                      setConfigureRevision((v) => v + 1);
                      return backend.configureAcp(scope, command);
                    },
                    discover: backend.discoverConfigureAcp,
                  },
                }}
              />
              {acp?.snapshot?.target && (
                <>
                  <dl aria-label="Codex ACP 只读状态">
                    <dt>账号观察</dt>
                    <dd>{view.accountLabel}</dd>
                    <dt>明确选择</dt>
                    <dd>{view.selectionLabel}</dd>
                    <dt>原生身份</dt>
                    <dd>
                      {acp.snapshot.target.nativeThreadId} /{" "}
                      {acp.snapshot.target.nativeTreeId}
                    </dd>
                    <dt>活动轮次</dt>
                    <dd>
                      {view.activeTurn?.nativeTurnId ?? "尚无已确认活动轮次"}
                    </dd>
                  </dl>
                  <CodexTranscript
                    conversation={view.transcript}
                    acp={view.acpTranscript}
                    session={binding}
                    summary={view.acpTranscript?.notice ?? view.historySummary}
                  />
                </>
              )}
            </CodexAcpSessionStart>
          ) : !native ? (
            <SessionStartPanel
              title={
                !direct
                  ? binding
                    ? "Codex ACP 原绑定会话"
                    : "新建 Codex ACP 会话"
                  : "继续 Codex 原生会话"
              }
              description={
                !direct
                  ? closedReason
                  : "使用已登记的 Codex 程序，按原生会话身份恢复历史和模型。"
              }
              connection={
                <button
                  disabled={!direct}
                  onClick={() => direct && setSettings(true)}
                >
                  程序与账号设置
                </button>
              }
              projectPath={path}
              projectLocked={!!binding}
              chooseProject={() => void chooseProject()}
              busy={busy}
              unavailable={
                !direct ||
                (!binding && (!status?.initialized || !model || !effort))
              }
              resume={
                direct && binding
                  ? () => void resume(binding.farfoldSessionId)
                  : undefined
              }
              create={binding ? newSession : () => void create()}
              primaryLabel={
                !direct
                  ? "ACP 入口暂未开放"
                  : busy
                    ? "正在核对…"
                    : binding
                      ? "继续原生会话"
                      : "新建原生会话"
              }
            >
              {!direct && <p role="status">{acpStatus}</p>}
              {direct && !binding && (
                <>
                  <button
                    disabled={busy || !status?.initialized}
                    onClick={() =>
                      void operation(async () => {
                        if (status) {
                          setCatalog(null);
                          setCatalog(await backend.catalog(status));
                        }
                      })
                    }
                  >
                    读取模型目录
                  </button>
                  <CodexModelFields
                    models={validCatalog?.models ?? []}
                    modelId={modelId}
                    effort={effort}
                    disabled={busy || !validCatalog}
                    effortDisabled={busy || !model}
                    onModel={(id) => {
                      setModelId(id);
                      setEffort(
                        validCatalog?.models.find((m) => m.id === id)
                          ?.defaultReasoningEffort ?? "",
                      );
                    }}
                    onEffort={setEffort}
                  />
                </>
              )}
            </SessionStartPanel>
          ) : conversation.turns.length > 0 ? (
            <CodexTranscript conversation={view.transcript} session={binding} />
          ) : (
            <div className="empty-conversation">
              <span className="brand-letter">F</span>
              <h2>开始 Codex 任务</h2>
              <p>支持文本任务、审批、Plan 提问、转向与停止。</p>
              <p>{native.thread.id}</p>
            </div>
          )}
          {binding &&
            pending.map((interaction) => (
              <CodexInteractionPanel
                key={interaction.key}
                interaction={interaction}
                turns={conversation.turns}
                onReply={(answer) =>
                  backend.reply(interaction.target, interaction.pending, answer)
                }
                enabled={
                  view.capabilities.reply &&
                  canSteer &&
                  interaction.request.turnId === conversation.nativeTurnId
                }
              />
            ))}
          {conversation.phase === "unknown" && (
            <div role="alert">
              <p>结果尚未确认。工作目录保持占用，输入不会自动重发。</p>
              <button onClick={() => void stopOwned()}>
                停止自有 Codex 连接并核对
              </button>
            </div>
          )}
          {details && (
            <details open>
              <summary>Codex 会话详情</summary>
              <p>{binding?.nativeSessionId ?? "尚未绑定"}</p>
              <p>{path}</p>
              <p>LifeModel 来源与消费尚未接入。</p>
            </details>
          )}
        </div>
        <Composer
          runtimeLabel="Codex"
          supportsSteering={direct}
          supportsFollowUp={false}
          steeringHint="发送到当前原生轮次，由 Codex 应用"
          running={!!native}
          ready={direct && connected && (!working || canSteer) && !busy}
          draftEditable={!!sessionId}
          notReadyReason={
            !direct
              ? closedReason
              : working
                ? "当前任务尚未结束，输入可保留"
                : "请先连接并打开原生会话"
          }
          working={working}
          submitting={busy || submitting}
          stopping={conversation.phase === "stopping"}
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
      </main>
      {deleting && (
        <SessionDeletionDialog
          sessionId={deleting.key}
          sessionTitle={deleting.title}
          onClose={() => setDeleting(null)}
        />
      )}
      {direct && settings && (
        <CodexInstallationDialog onClose={() => setSettings(false)} />
      )}
      <CommandPalette
        open={commands}
        themeMode={props.themeMode}
        onThemeMode={props.onThemeMode}
        onOpen={() => setCommands(true)}
        onClose={() => setCommands(false)}
        items={[
          {
            id: "codex-settings",
            label: "Codex 程序与账号",
            description: "检查当前环境连接",
            onSelect: () =>
              direct ? setSettings(true) : setError(closedReason),
          },
          {
            id: "updates",
            label: "检查应用更新",
            description: "打开更新与恢复",
            onSelect: props.onOpenUpdate,
          },
        ]}
      />
      {lifeModel.open && <LifeModelPanel {...lifeModel} />}
    </div>
  );
}
