import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderSimple, Key, X } from "@phosphor-icons/react";
import appIconUrl from "../assets/app-icon.svg";
import { Composer } from "./components/Composer";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { MessageContent } from "./components/MessageContent";
import { PiActivity, QueueNotice } from "./components/PiActivity";
import { ProviderSettings } from "./components/ProviderSettings";
import { Sidebar } from "./components/Sidebar";
import {
  hydrateTimeline,
  initialConversation,
  reducePiEvent,
  type ConversationState,
} from "./runtime/conversation";
import {
  acceptsRuntimeEvent,
  lifecycleFailureMessage,
  listSessions,
  parseExtensionUiRequest,
  providerAuthStatus,
  rejectPendingRpc,
  rememberSession,
  removeProviderAuth,
  pollPiEvents,
  runtimeStatus,
  sendRpc,
  settleRpcResponse,
  setProviderApiKey,
  startRuntime,
  stopRuntime,
  type PiEnvelope,
  type ExtensionDialogRequest,
  type ProviderAuthStatus,
  type ProjectTrust,
  type RuntimeStatus,
  type SessionSummary,
} from "./runtime/pi";

interface PiModel {
  provider: string;
  id: string;
  name?: string;
}

interface PiState {
  model: PiModel | null;
  isStreaming: boolean;
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  pendingMessageCount: number;
  contextPercent: number | null;
}

interface PiCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
}

type ProviderRequestState = "unverified" | "working" | "success" | "failed";

const initialStatus: RuntimeStatus = {
  state: "stopped",
  running: false,
  projectPath: null,
  sessionDir: null,
  generation: 0,
  savedProjectPath: null,
  savedSessionFile: null,
};

const initialPiState: PiState = {
  model: null,
  isStreaming: false,
  sessionFile: null,
  sessionId: null,
  sessionName: null,
  pendingMessageCount: 0,
  contextPercent: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isResponse(value: unknown): value is Record<string, unknown> {
  return asRecord(value)?.type === "response";
}

function projectName(path: string | null): string {
  if (!path) return "未选择 Project";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function trimTitle(value: string, max = 34): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function elapsedLabel(startedAt: number | null, now: number): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

export default function App() {
  const [status, setStatus] = useState(initialStatus);
  const [runtimeTransition, setRuntimeTransition] = useState<
    "starting" | "stopping" | null
  >(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectTrust, setProjectTrust] = useState<ProjectTrust>("saved");
  const [conversation, setConversation] =
    useState<ConversationState>(initialConversation);
  const [piState, setPiState] = useState(initialPiState);
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelDiscovery, setModelDiscovery] = useState<
    "idle" | "loading" | "ready"
  >("idle");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [commands, setCommands] = useState<PiCommandInfo[]>([]);
  const [providerRequestState, setProviderRequestState] =
    useState<ProviderRequestState>("unverified");
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [providerSettingsBusy, setProviderSettingsBusy] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<"steer" | "follow_up">("steer");
  const [error, setError] = useState<string | null>(null);
  const [extensionDialogs, setExtensionDialogs] = useState<
    ExtensionDialogRequest[]
  >([]);
  const [extensionNotice, setExtensionNotice] = useState<{
    message: string;
    type: "info" | "warning" | "error";
  } | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<
    Record<string, string>
  >({});
  const [extensionWidgets, setExtensionWidgets] = useState<
    Record<
      string,
      { lines: string[]; placement: "aboveEditor" | "belowEditor" }
    >
  >({});
  const [workStartedAt, setWorkStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const runtimeGeneration = useRef(0);

  const working = piState.isStreaming || conversation.isWorking;
  const runtimePhase = runtimeTransition ?? status.state;
  const transitioning =
    runtimePhase === "starting" || runtimePhase === "stopping";
  const extensionStatus = Object.values(extensionStatuses).join(" · ");
  const extensionWidgetAbove = Object.values(extensionWidgets)
    .filter((widget) => widget.placement === "aboveEditor")
    .flatMap((widget) => widget.lines);
  const extensionWidgetBelow = Object.values(extensionWidgets)
    .filter((widget) => widget.placement === "belowEditor")
    .flatMap((widget) => widget.lines);
  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.sessionFile === piState.sessionFile),
    [piState.sessionFile, sessions],
  );
  const displayTimeline = useMemo(() => {
    type TimelineEntry = (typeof conversation.timeline)[number];
    type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;
    type DisplayEntry =
      TimelineEntry | { kind: "tools"; id: string; tools: ToolEntry[] };
    return conversation.timeline.reduce<DisplayEntry[]>((groups, item) => {
      if (item.kind !== "tool") {
        groups.push(item);
        return groups;
      }
      const previous = groups.at(-1);
      if (previous?.kind === "tools") {
        previous.tools.push(item);
      } else {
        groups.push({ kind: "tools", id: item.id, tools: [item] });
      }
      return groups;
    }, []);
  }, [conversation.timeline]);
  const firstUserMessage = conversation.timeline.find(
    (item) => item.kind === "message" && item.role === "user" && item.text,
  );
  const conversationTitle = trimTitle(
    piState.sessionName ||
      activeSession?.title ||
      (firstUserMessage?.kind === "message" ? firstUserMessage.text : "") ||
      "新对话",
  );
  const currentProject = status.projectPath ?? projectPath;
  const configuredProviderCount = providers.filter(
    (provider) => provider.configured,
  ).length;
  const activeProvider =
    providers.find((provider) => provider.id === piState.model?.provider) ??
    providers.find((provider) => provider.configured) ??
    null;
  const providerStateLabel = !activeProvider?.configured
    ? "未配置"
    : providerRequestState === "success"
      ? "最近请求成功"
      : providerRequestState === "failed"
        ? "最近请求失败"
        : providerRequestState === "working"
          ? "请求中"
          : "已配置 · 待验证";
  const canResume = Boolean(
    status.savedSessionFile && status.savedProjectPath === projectPath,
  );

  function applyRuntimeStatus(next: RuntimeStatus): boolean {
    if (next.generation < runtimeGeneration.current) return false;
    if (next.generation > runtimeGeneration.current) {
      rejectPendingRpc("Pi 运行状态已切换，请重试未完成的请求。");
    }
    runtimeGeneration.current = next.generation;
    setStatus(next);
    return true;
  }

  function reloadSessions() {
    void listSessions().then(setSessions, (reason) => setError(String(reason)));
  }

  function reloadProviders() {
    void providerAuthStatus().then(setProviders, (reason) =>
      setError(String(reason)),
    );
  }

  function refreshPi(running: boolean) {
    if (!running) return;
    void Promise.all([
      sendRpc({ type: "get_state" }),
      sendRpc({ type: "get_available_models" }),
      sendRpc({ type: "get_messages" }),
      sendRpc({ type: "get_commands" }),
      sendRpc({ type: "get_session_stats" }),
    ]).catch((reason) => setError(String(reason)));
  }

  function handleResponse(response: Record<string, unknown>) {
    if (response.success !== true) {
      setError(
        typeof response.error === "string" ? response.error : "Pi 拒绝了请求。",
      );
      return;
    }
    const data = asRecord(response.data);
    if (response.command === "get_state") {
      const model = asRecord(data?.model);
      const next: PiState = {
        model:
          model &&
          typeof model.provider === "string" &&
          typeof model.id === "string"
            ? {
                provider: model.provider,
                id: model.id,
                name: typeof model.name === "string" ? model.name : undefined,
              }
            : null,
        isStreaming: data?.isStreaming === true,
        sessionFile:
          typeof data?.sessionFile === "string" ? data.sessionFile : null,
        sessionId: typeof data?.sessionId === "string" ? data.sessionId : null,
        sessionName:
          typeof data?.sessionName === "string" ? data.sessionName : null,
        pendingMessageCount:
          typeof data?.pendingMessageCount === "number"
            ? data.pendingMessageCount
            : 0,
        contextPercent: null,
      };
      setPiState((current) => ({
        ...next,
        contextPercent: current.contextPercent,
      }));
      if (next.isStreaming) {
        setWorkStartedAt((current) => current ?? Date.now());
      }
      if (next.sessionFile) {
        void rememberSession(next.sessionFile).then(
          (saved) => {
            if (saved) {
              void runtimeStatus().then(setStatus);
              reloadSessions();
            }
          },
          (reason) => setError(String(reason)),
        );
      }
    } else if (response.command === "get_session_stats") {
      const context = asRecord(data?.contextUsage);
      setPiState((current) => ({
        ...current,
        contextPercent:
          typeof context?.percent === "number" ? context.percent : null,
      }));
    } else if (response.command === "get_available_models") {
      setModels(
        (Array.isArray(data?.models) ? data.models : []).flatMap(
          (candidate) => {
            const model = asRecord(candidate);
            return model &&
              typeof model.provider === "string" &&
              typeof model.id === "string"
              ? [
                  {
                    provider: model.provider,
                    id: model.id,
                    name:
                      typeof model.name === "string" ? model.name : undefined,
                  },
                ]
              : [];
          },
        ),
      );
      setModelDiscovery("ready");
    } else if (response.command === "get_messages") {
      setConversation((current) => ({
        ...current,
        timeline: hydrateTimeline(data?.messages),
      }));
    } else if (response.command === "get_commands") {
      setCommands(
        (Array.isArray(data?.commands) ? data.commands : []).flatMap(
          (candidate) => {
            const command = asRecord(candidate);
            const source = command?.source;
            return command &&
              typeof command.name === "string" &&
              (source === "extension" ||
                source === "prompt" ||
                source === "skill")
              ? [
                  {
                    name: command.name,
                    source,
                    ...(typeof command.description === "string"
                      ? { description: command.description }
                      : {}),
                    ...(command.location === "user" ||
                    command.location === "project" ||
                    command.location === "path"
                      ? { location: command.location }
                      : {}),
                  },
                ]
              : [];
          },
        ),
      );
    } else if (response.command === "set_model") {
      refreshPi(true);
    } else if (
      response.command === "new_session" ||
      response.command === "switch_session"
    ) {
      if (asRecord(response.data)?.cancelled === true) return;
      setConversation(initialConversation);
      setPiState((current) => ({ ...current, contextPercent: null }));
      refreshPi(true);
      reloadSessions();
    }
  }

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    void runtimeStatus().then((next) => {
      if (!cancelled) {
        if (applyRuntimeStatus(next)) {
          setProjectPath(next.projectPath ?? next.savedProjectPath);
          refreshPi(next.running);
        }
      }
    });
    reloadSessions();
    reloadProviders();

    function handlePiEvent(event: PiEnvelope) {
      if (!acceptsRuntimeEvent(runtimeGeneration.current, event)) return;
      if (event.generation > runtimeGeneration.current) {
        rejectPendingRpc("Pi 已切换到新的运行代际，请重试请求。");
      }
      runtimeGeneration.current = event.generation;
      if (event.kind === "rpc") {
        if (isResponse(event.payload)) {
          settleRpcResponse(event.payload);
          handleResponse(event.payload);
        } else {
          const extensionRequest = parseExtensionUiRequest(event.payload);
          if (extensionRequest) {
            if (
              extensionRequest.method === "select" ||
              extensionRequest.method === "confirm" ||
              extensionRequest.method === "input" ||
              extensionRequest.method === "editor"
            ) {
              setExtensionDialogs((current) =>
                current.some((request) => request.id === extensionRequest.id)
                  ? current
                  : [...current, extensionRequest],
              );
            } else if (extensionRequest.method === "notify") {
              setExtensionNotice({
                message: extensionRequest.message ?? "Pi Extension 通知",
                type: extensionRequest.notifyType ?? "info",
              });
            } else if (extensionRequest.method === "setStatus") {
              setExtensionStatuses((current) => {
                const next = { ...current };
                const key = extensionRequest.statusKey ?? extensionRequest.id;
                if (extensionRequest.statusText) {
                  next[key] = extensionRequest.statusText;
                } else {
                  delete next[key];
                }
                return next;
              });
            } else if (extensionRequest.method === "setWidget") {
              setExtensionWidgets((current) => {
                const next = { ...current };
                const key = extensionRequest.widgetKey ?? extensionRequest.id;
                if (extensionRequest.widgetLines?.length) {
                  next[key] = {
                    lines: extensionRequest.widgetLines,
                    placement:
                      extensionRequest.widgetPlacement ?? "aboveEditor",
                  };
                } else {
                  delete next[key];
                }
                return next;
              });
            } else if (extensionRequest.method === "setTitle") {
              document.title = extensionRequest.title || "Farfold";
            } else if (extensionRequest.method === "set_editor_text") {
              setMessage(extensionRequest.text ?? "");
            }
          }
          const type = asRecord(event.payload)?.type;
          if (type === "agent_start") {
            setWorkStartedAt(Date.now());
            setProviderRequestState("working");
          }
          if (type === "message_end") {
            const message = asRecord(asRecord(event.payload)?.message);
            if (message?.role === "assistant") {
              setProviderRequestState(
                typeof message.errorMessage === "string" ? "failed" : "success",
              );
            }
          }
          if (type === "agent_settled") {
            setWorkStartedAt(null);
            void sendRpc({ type: "get_state" });
            void sendRpc({ type: "get_messages" });
            void sendRpc({ type: "get_session_stats" });
            reloadSessions();
          }
          setConversation((current) => reducePiEvent(current, event.payload));
        }
      }
      if (event.kind === "lifecycle") {
        void runtimeStatus().then((next) => {
          if (applyRuntimeStatus(next)) refreshPi(next.running);
        });
      }
      if (event.kind === "lifecycle" && event.payload.state === "terminated") {
        rejectPendingRpc("Pi 已停止，未完成的请求已取消。");
        setRuntimeTransition(null);
        setWorkStartedAt(null);
        const failure = lifecycleFailureMessage(event.payload);
        if (failure) setError(failure);
      }
      if (event.kind === "stderr")
        setError(`Pi sidecar：${event.payload.trim()}`);
      if (event.kind === "protocol_error") {
        setError(`Pi 协议错误：${event.payload.error}`);
      }
    }

    const interval = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void pollPiEvents()
        .then((events) => events.forEach(handlePiEvent))
        .catch((reason) => setError(String(reason)))
        .finally(() => {
          polling = false;
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.timeline, conversation.steering]);

  async function chooseProject(switchRunning = false) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Farfold Project",
    });
    if (typeof selected !== "string") return;
    setProjectPath(selected);
    if (!switchRunning || !status.running) return;

    setError(null);
    try {
      setRuntimeTransition("stopping");
      const stopped = await stopRuntime();
      applyRuntimeStatus(stopped);
      setConversation(initialConversation);
      setPiState(initialPiState);
      setModels([]);
      setCommands([]);
      setModelDiscovery("loading");
      setProviderRequestState("unverified");
      setRuntimeTransition("starting");
      const restarted = await startRuntime({
        projectPath: selected,
        sessionFile: null,
        resumePrevious: false,
        projectTrust,
      });
      applyRuntimeStatus(restarted);
      refreshPi(restarted.running);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
    }
  }

  async function start(
    resumePrevious: boolean,
    session?: SessionSummary,
  ): Promise<void> {
    if (transitioning) return;
    setError(null);
    setRuntimeTransition("starting");
    try {
      const next = await startRuntime({
        projectPath: session?.projectPath ?? projectPath,
        sessionFile: session?.sessionFile ?? null,
        resumePrevious,
        projectTrust,
      });
      applyRuntimeStatus(next);
      setProjectPath(next.projectPath ?? session?.projectPath ?? projectPath);
      setModels([]);
      setCommands([]);
      setModelDiscovery("loading");
      refreshPi(next.running);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRuntimeTransition(null);
    }
  }

  async function send() {
    const text = message.trim();
    if (!text || !status.running || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await sendRpc({ type: working ? delivery : "prompt", message: text });
      if (!working) {
        setConversation((current) => ({
          ...current,
          timeline: [
            ...current.timeline,
            {
              kind: "message",
              id: `local-${Date.now()}`,
              role: "user",
              text,
            },
          ],
        }));
      }
      setMessage("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function abort() {
    setError(null);
    try {
      await sendRpc({ type: "abort" });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function newSession() {
    if (transitioning) return;
    if (!status.running) {
      await start(false);
      return;
    }
    if (working) return;
    setError(null);
    try {
      await sendRpc({ type: "new_session" });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function openSession(session: SessionSummary) {
    if (session.sessionFile === piState.sessionFile || working || transitioning)
      return;
    setError(null);
    try {
      if (status.running && session.projectPath === status.projectPath) {
        await sendRpc({
          type: "switch_session",
          sessionPath: session.sessionFile,
        });
      } else {
        if (status.running) {
          setRuntimeTransition("stopping");
          const stopped = await stopRuntime();
          applyRuntimeStatus(stopped);
          setRuntimeTransition(null);
        }
        await start(false, session);
      }
    } catch (reason) {
      setError(String(reason));
      setRuntimeTransition(null);
    }
  }

  async function selectModel(value: string) {
    const [provider, ...idParts] = value.split("/");
    const modelId = idParts.join("/");
    if (!provider || !modelId) return;
    setError(null);
    try {
      await sendRpc({ type: "set_model", provider, modelId });
      setProviderRequestState("unverified");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function restartAfterProviderChange(
    wasRunning: boolean,
    previousProject: string | null,
    previousSession: string | null,
  ) {
    const stopped = await runtimeStatus();
    applyRuntimeStatus(stopped);
    if (!wasRunning) return;

    setRuntimeTransition("starting");
    const restarted = await startRuntime({
      projectPath: previousProject,
      sessionFile: previousSession,
      resumePrevious: Boolean(previousSession),
      projectTrust: "saved",
    });
    applyRuntimeStatus(restarted);
    setModels([]);
    setModelDiscovery("loading");
    refreshPi(restarted.running);
  }

  async function saveProviderApiKey(provider: string, apiKey: string) {
    const wasRunning = status.running;
    const previousProject = status.projectPath ?? projectPath;
    const previousSession = piState.sessionFile;
    setProviderSettingsBusy(true);
    setError(null);
    try {
      const nextProviders = await setProviderApiKey(provider, apiKey);
      setProviders(nextProviders);
      setProviderRequestState("unverified");
      await restartAfterProviderChange(
        wasRunning,
        previousProject,
        previousSession,
      );
      setProviderSettingsOpen(false);
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setRuntimeTransition(null);
      setProviderSettingsBusy(false);
    }
  }

  async function removeProvider(provider: string) {
    const wasRunning = status.running;
    const previousProject = status.projectPath ?? projectPath;
    const previousSession = piState.sessionFile;
    setProviderSettingsBusy(true);
    setError(null);
    try {
      const nextProviders = await removeProviderAuth(provider);
      setProviders(nextProviders);
      setProviderRequestState("unverified");
      await restartAfterProviderChange(
        wasRunning,
        previousProject,
        previousSession,
      );
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setRuntimeTransition(null);
      setProviderSettingsBusy(false);
    }
  }

  function answerExtensionDialog(response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }) {
    const request = extensionDialogs[0];
    if (!request) return;
    setExtensionDialogs((current) => current.slice(1));
    void sendRpc({
      type: "extension_ui_response",
      id: request.id,
      ...response,
    }).catch((reason) => setError(String(reason)));
  }

  function expireExtensionDialog() {
    setExtensionDialogs((current) => current.slice(1));
  }

  return (
    <div className="app-shell">
      <Sidebar
        sessions={sessions}
        activeSessionFile={piState.sessionFile}
        search={sessionSearch}
        projectFilter={projectFilter}
        disabled={working || submitting || transitioning}
        configuredProviderCount={configuredProviderCount}
        onSearch={setSessionSearch}
        onProjectFilter={setProjectFilter}
        onNew={() => void newSession()}
        onSelect={(session) => void openSession(session)}
        onOpenProviderSettings={() => setProviderSettingsOpen(true)}
      />

      <main className="workspace">
        <header className="workspace-header">
          <h1>{conversationTitle}</h1>
          <div className="header-meta">
            <button
              className="header-project"
              title={currentProject ?? undefined}
              onClick={() => void chooseProject(true)}
              disabled={working || submitting || transitioning}
            >
              <FolderSimple size={14} />
              {projectName(currentProject)}
            </button>
            <span className="header-separator" />
            <button
              className="header-provider"
              onClick={() => setProviderSettingsOpen(true)}
              disabled={working || submitting || transitioning}
              title="打开 Provider 设置"
            >
              <Key size={13} />
              {activeProvider?.name ?? "配置 Provider"}
              <i
                className={
                  activeProvider?.configured
                    ? providerRequestState === "success"
                      ? "success"
                      : providerRequestState === "failed"
                        ? "failed"
                        : "configured"
                    : ""
                }
              />
            </button>
            <span className="header-separator" />
            <div className={`runtime-state${working ? " working" : ""}`}>
              <i />
              {working
                ? `Pi 正在工作 · ${elapsedLabel(workStartedAt, now)}`
                : runtimePhase === "starting"
                  ? "Pi 正在启动"
                  : runtimePhase === "stopping"
                    ? "Pi 正在停止"
                    : status.running
                      ? "Pi 已启动"
                      : "Pi 未启动"}
            </div>
            {extensionStatus && (
              <span className="extension-status" title={extensionStatus}>
                {extensionStatus}
              </span>
            )}
          </div>
        </header>

        <section className="conversation-scroll" aria-live="polite">
          {!status.running ? (
            <div className="start-state">
              <img src={appIconUrl} alt="" />
              <h2>{canResume ? "继续最近的对话" : "开始一段新对话"}</h2>
              <p>选择一个 Project，Farfold 会在其中启动原生 Pi Session。</p>
              <button
                className="provider-entry"
                onClick={() => setProviderSettingsOpen(true)}
                disabled={transitioning}
              >
                <Key size={19} />
                <span>
                  <small>Provider</small>
                  <strong>{activeProvider?.name ?? "添加 API Key"}</strong>
                </span>
                <em className={activeProvider?.configured ? "configured" : ""}>
                  {providerStateLabel}
                </em>
              </button>
              <button
                className="project-picker"
                onClick={() => void chooseProject(false)}
                disabled={transitioning}
              >
                <FolderOpen size={20} />
                <span>
                  <small>Project</small>
                  <strong>{projectPath ?? "选择文件夹"}</strong>
                </span>
              </button>
              <label className="trust-picker">
                <span>Project 资源</span>
                <select
                  value={projectTrust}
                  disabled={transitioning}
                  onChange={(event) =>
                    setProjectTrust(event.target.value as ProjectTrust)
                  }
                >
                  <option value="saved">遵循 Pi 已保存信任</option>
                  <option value="approve">仅本次信任并载入</option>
                  <option value="ignore">本次忽略 Project 资源</option>
                </select>
              </label>
              <div className="start-actions">
                <button
                  className="start-primary"
                  onClick={() => void start(canResume)}
                  disabled={transitioning}
                >
                  {runtimePhase === "starting"
                    ? "正在启动…"
                    : canResume
                      ? "继续对话"
                      : "启动 Agent"}
                </button>
                {canResume && (
                  <button
                    onClick={() => void start(false)}
                    disabled={transitioning}
                  >
                    新建 Session
                  </button>
                )}
              </div>
            </div>
          ) : conversation.timeline.length === 0 ? (
            <div className="empty-conversation">
              <span className="brand-letter">F</span>
              <h2>现在想完成什么？</h2>
              <p>直接描述目标，Farfold 会把任务交给当前 Pi Session。</p>
            </div>
          ) : (
            <div className="message-list">
              {displayTimeline.map((item) =>
                item.kind === "message" ? (
                  <article
                    className={`message ${item.role}${item.error ? " error-message" : ""}`}
                    key={`message-${item.id}`}
                  >
                    {item.role === "assistant" && (
                      <span className="assistant-mark">F</span>
                    )}
                    <div>
                      <p className="message-label">
                        {item.role === "user" ? "你" : "Farfold"}
                      </p>
                      {item.role === "assistant" ? (
                        <MessageContent
                          text={item.text || (item.pending ? "正在思考…" : "")}
                          thinking={item.thinking}
                        />
                      ) : (
                        <p className="message-text">{item.text}</p>
                      )}
                    </div>
                  </article>
                ) : item.kind === "tools" ? (
                  <PiActivity
                    key={`tools-${item.id}`}
                    tools={item.tools}
                    notice={null}
                  />
                ) : null,
              )}
              <PiActivity tools={[]} notice={conversation.notice} />
              <QueueNotice
                steering={conversation.steering}
                followUp={conversation.followUp}
              />
            </div>
          )}
          {status.running &&
            modelDiscovery === "ready" &&
            models.length === 0 && (
              <div className="inline-warning">
                <span>Pi 未返回可用模型。请检查 Provider 凭据后重试。</span>
                <button onClick={() => setProviderSettingsOpen(true)}>
                  打开 Provider 设置
                </button>
              </div>
            )}
          <div ref={transcriptEnd} />
        </section>

        <div className="runtime-notices">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="关闭错误">
                <X size={15} />
              </button>
            </div>
          )}

          {extensionNotice && (
            <div
              className={`extension-notice ${extensionNotice.type}`}
              role={extensionNotice.type === "error" ? "alert" : "status"}
            >
              <span>{extensionNotice.message}</span>
              <button
                onClick={() => setExtensionNotice(null)}
                aria-label="关闭通知"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {extensionWidgetAbove.length > 0 && (
            <div className="extension-widget">
              {extensionWidgetAbove.map((line, index) => (
                <span key={`${index}-${line}`}>{line}</span>
              ))}
            </div>
          )}
        </div>

        <Composer
          running={status.running && !transitioning}
          working={working}
          submitting={submitting}
          message={message}
          delivery={delivery}
          projectName={projectName(currentProject)}
          model={piState.model}
          models={models}
          contextPercent={piState.contextPercent}
          commands={commands}
          onMessage={setMessage}
          onDelivery={setDelivery}
          onSend={() => void send()}
          onAbort={() => void abort()}
          onSelectModel={(value) => void selectModel(value)}
        />
        {extensionWidgetBelow.length > 0 && (
          <div className="extension-widget below-editor">
            {extensionWidgetBelow.map((line, index) => (
              <span key={`${index}-${line}`}>{line}</span>
            ))}
          </div>
        )}
      </main>
      {extensionDialogs[0] && (
        <ExtensionDialog
          request={extensionDialogs[0]}
          onRespond={answerExtensionDialog}
          onExpire={expireExtensionDialog}
        />
      )}
      {providerSettingsOpen && (
        <ProviderSettings
          providers={providers}
          preferredProvider={piState.model?.provider}
          busy={providerSettingsBusy}
          onClose={() => setProviderSettingsOpen(false)}
          onSave={saveProviderApiKey}
          onRemove={removeProvider}
        />
      )}
    </div>
  );
}
