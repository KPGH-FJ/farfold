import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  SidebarSimple,
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  Copy,
  DotsThree,
  FileText,
  ListBullets,
  MagnifyingGlass,
  Pause,
  PencilSimple,
  Play,
  X,
} from "@phosphor-icons/react";
import { AgentIcon, Badge, Button, Modal, Notice, Status } from "./ui";
import "./conversation.css";
import "./conversation-refresh.css";
import ConversationComposer from "./ConversationComposer.jsx";
import useConversationPermission from "./useConversationPermission.js";
import { permissionChangeState } from "./permission-state.js";
import ConversationTranscript from "./ConversationTranscript.jsx";
import AccessTestTranscript from "./AccessTestTranscript.jsx";
import AttachmentRecoveryDialog from "./AttachmentRecoveryDialog.jsx";
import {
  threadAttachmentReviewItems,
  confirmThreadAttachments,
} from "./attachment-recovery.js";
import ExecutionReviewControls, {
  HistoryReading,
  MissingIdentity,
} from "./ExecutionReviewControls.jsx";
import { conversationState } from "./conversation-policy.js";
import {
  createPreviewClock,
  canAnswerPreview,
  rememberReply,
  resumePreview,
  latestArtifactReply,
  readableTranscript,
  resolvePreviewRecovery,
  previewQueueGate,
  canReleasePreviewQueue,
  previewConversationBlocked,
  beginPreviewQueueEdit,
  savePreviewQueueEdit,
  beginPreviewDecisionResult,
} from "./conversation-state.js";
import { WORKSPACE_DATA } from "./workspace-scenarios.js";
import WorkspacePanel from "./WorkspacePanel.jsx";
import {
  scenarioFor,
  previewKindFor,
  previewFilesFor,
} from "./ConversationScenarios.jsx";

import {
  FILES,
  INITIAL_APPROVALS,
  normalQueue,
  normalMessages,
  isPresetTask,
  hasPresetResults,
  SentAttachments,
  projectName,
  ArtifactDrawer,
} from "./ConversationParts.jsx";

export default function Conversation({
  task,
  onTaskChange: publishTaskChange,
  onNew,
  onSettings,
  onResumeSending,
  onBack,
  onToggleNavigation,
  navigationCollapsed = false,
  toast,
  workEnabled = true,
  active = true,
  serviceMissing = false,
  serviceIssue = null,
  agentUnavailable = false,
  onAccessTestAction,
  onReturnToPreparation,
  agentPermissionCapability,
}) {
  const onTaskChange = (patch) => {
    if (patch) publishTaskChange(patch);
  };
  const workspace = WORKSPACE_DATA[task.workspaceKind];
  const workspacePanel = task.workspacePanel || {
    open: true,
    tab: { review: "diff", web: "preview", document: "compare", run: "tests" }[
      task.workspaceKind
    ],
  };
  const [pane, setPane] = useState(null);
  const [menu, setMenu] = useState(false);
  const [find, setFind] = useState(null);
  const [findMatches, setFindMatches] = useState(0);
  const [rename, setRename] = useState(null);
  const [queueEdit, setQueueEdit] = useState(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachmentReviewOpen, setAttachmentReviewOpen] = useState(false);
  const [clockStopping, setStopping] = useState(false);
  const stopping =
    clockStopping || ["waiting", "unknown"].includes(task.stopPhase);
  const activity = conversationState(task);
  const [recoveryState, setRecoveryState] = useState("idle");
  const [recoveryDemo, setRecoveryDemo] = useState("mismatch");
  const [unknownDemo, setUnknownDemo] = useState("unknown");
  const [showLatest, setShowLatest] = useState(false);
  const transcript = useRef(null);
  const lastContent = useRef(
    `${task.id}:${task.status}:${task.extraMessages?.length || 0}`,
  );
  const clock = useRef(null);
  if (!clock.current) clock.current = createPreviewClock(setStopping);
  const latest = useRef(task);
  latest.current = task;
  const workAllowed = useRef(workEnabled);
  workAllowed.current = workEnabled;
  const sourceAvailable = useRef(!serviceMissing);
  sourceAvailable.current = !serviceMissing;
  const agentAvailable = useRef(!agentUnavailable);
  agentAvailable.current = !agentUnavailable;
  const isRunning = task.status === "running";
  const blocked =
    previewConversationBlocked(task) ||
    stopping ||
    serviceMissing ||
    agentUnavailable;
  const pending = ["approval", "question"].includes(task.status);
  const isDraft = task.status === "draft";
  const queue = normalQueue(task.queue);
  const text = task.draft || "";
  const attachments = task.attachments || [];
  const paused =
    Boolean(task.queuePaused) ||
    ["stopped", "recovery", "unknown"].includes(task.status);
  const permissionCapability =
    task.permissionCapability || agentPermissionCapability;
  const permissionContext = {
    connectionBroken: agentUnavailable || serviceMissing,
    pending: stopping,
  };
  const permissionGate = permissionChangeState(task, permissionContext);
  const permission = useConversationPermission(
    task,
    permissionCapability,
    onTaskChange,
    permissionContext,
  );
  useEffect(() => {
    const patch = previewQueueGate(latest.current, {
      workEnabled,
      sourceAvailable: !serviceMissing,
      agentAvailable: !agentUnavailable,
    });
    if (patch) onTaskChange(patch);
  }, [
    workEnabled,
    serviceMissing,
    agentUnavailable,
    task.queuePaused,
    task.attachmentsNeedReview,
    task.status,
    task.identityIncomplete,
    task.readOnly,
    task.stopPhase,
    task.connectionState,
    task.admissionUnknown,
    task.recoveryRead,
    task.permissionChange,
  ]);
  const openPane = (tab = "files", file = 0, reply) =>
    setPane({ tab, file, reply: reply || latestArtifactReply(latest.current) });
  const emit = (message) => toast?.(message);
  const selectWorkspace = (patch) =>
    onTaskChange({
      workspacePanel: {
        ...workspacePanel,
        open: true,
        ...patch,
        focusTick: Date.now(),
      },
    });
  const feedbackToInput = (value) => {
    onTaskChange({
      draft: [task.draft?.trim(), value].filter(Boolean).join("\n\n"),
    });
    transcript.current?.parentElement
      .querySelector('textarea[aria-label="消息内容"]')
      ?.focus();
    emit("反馈已带回输入框，可编辑后发送");
  };
  useEffect(() => {
    const content = `${task.id}:${task.status}:${task.extraMessages?.length || 0}`;
    if (content !== lastContent.current && !showLatest) {
      transcript.current?.scrollTo({
        top: transcript.current.scrollHeight,
        behavior: "smooth",
      });
    }
    lastContent.current = content;
  }, [task.id, task.status, task.extraMessages?.length, showLatest]);
  useEffect(() => {
    setPane(null);
    setMenu(false);
    setFind(null);
    setRename(null);
    setQueueEdit(null);
    setAttachmentsOpen(false);
    setStopping(false);
    setRecoveryState("idle");
    clock.current.dispose();
    return () => clock.current.dispose();
  }, [task.id]);
  const finishLater = () => {
    if (task.accessTest) return;
    const id = task.id;
    if (clock.current.stopping) return;
    const advance = () => {
      const current = latest.current;
      if (current.id !== id || current.status !== "running") return;
      const pendingQueue = normalQueue(current.queue);
      const presetCompleted =
        hasPresetResults(current) ||
        (isPresetTask(current) &&
          (!current.resultMode || current.resultMode === "preset"));
      if (
        pendingQueue.length &&
        canReleasePreviewQueue(current, {
          workEnabled: workAllowed.current,
          sourceAvailable: sourceAvailable.current,
          agentAvailable: agentAvailable.current,
        })
      ) {
        const [first, ...rest] = pendingQueue;
        onTaskChange({
          status: "running",
          archived: false,
          replyHistory: rememberReply(current, "done"),
          hasPresetResults: presetCompleted,
          resultMode: "simulated",
          previewKind: previewKindFor(
            first.text,
            current.previewKind || current.demoKind,
          ),
          previewPrompt: first.text,
          queue: rest,
          extraMessages: [
            ...normalMessages(current.extraMessages),
            { text: first.text, attachments: first.attachments || [] },
          ],
        });
        clock.current.work(advance);
      } else {
        onTaskChange({
          status: "done",
          terminalConfirmed: true,
          stopPhase: null,
          hasPresetResults: presetCompleted,
          resultMode:
            current.resultMode ||
            (isPresetTask(current) ? "preset" : "simulated"),
          ...(pendingQueue.length ? { queuePaused: true } : {}),
        });
      }
    };
    clock.current.work(advance);
  };
  useEffect(() => {
    if (task.simulatePending && task.status === "running") {
      onTaskChange({
        simulatePending: false,
        resultMode: "simulated",
        previewKind: previewKindFor(task.prompt, task.demoKind),
        previewPrompt: task.prompt,
      });
      finishLater();
    }
  }, [task.simulatePending, task.id]);
  const send = () => {
    if (
      (!text.trim() && !attachments.length) ||
      blocked ||
      stopping ||
      !workEnabled
    )
      return;
    if (isRunning || pending || (paused && queue.length > 0)) {
      onTaskChange({
        archived: false,
        queue: [
          ...queue,
          {
            id: `q-${Date.now()}`,
            text: text.trim(),
            attachments,
          },
        ],
        draft: "",
        attachments: [],
      });
      if (isRunning && !clock.current.working) finishLater();
      emit(
        paused
          ? "已加入待发，继续发送前会保留"
          : "已加入待发，当前任务结束后发送",
      );
      return;
    }
    onTaskChange({
      ...resumePreview(latest.current),
      status: "running",
      recoveryRead: null,
      draft: "",
      attachments: [],
      queuePaused: false,
      hasPresetResults: hasPresetResults(task),
      resultMode: "simulated",
      previewKind: previewKindFor(text, task.previewKind || task.demoKind),
      previewPrompt: text.trim(),
      ...(isDraft
        ? {
            prompt: text.trim(),
            sentAttachments: [...attachments],
          }
        : {
            extraMessages: [
              ...normalMessages(task.extraMessages),
              {
                text: text.trim(),
                attachments: [...attachments],
              },
            ],
          }),
    });
    finishLater();
  };
  const stop = () => {
    if (task.accessTest) {
      onAccessTestAction?.("stop", task.id);
      return;
    }
    if (clock.current.stopping) return;
    const id = task.id;
    const outcome = task.stopDemo || "confirmed";
    onTaskChange({ queuePaused: true, stopPhase: "waiting" });
    clock.current.stop(() => {
      if (latest.current.id !== id || latest.current.stopPhase !== "waiting")
        return;
      if (outcome === "confirmed") {
        onTaskChange({
          status: "stopped",
          terminalConfirmed: true,
          stopPhase: null,
          queuePaused: true,
        });
        emit("Agent 已确认停止，待发消息已保留");
      } else {
        onTaskChange({ stopPhase: outcome, queuePaused: true });
        emit(
          outcome === "failed"
            ? "停止请求未发送成功，原审批与问题仍保留"
            : "尚未收到停止确认，原审批与问题仍保留",
        );
      }
    });
  };
  const continueQueue = () => {
    if (
      stopping ||
      blocked ||
      pending ||
      isRunning ||
      !queue.length ||
      !workEnabled
    )
      return;
    const [first, ...rest] = queue;
    onTaskChange({
      ...resumePreview(latest.current),
      status: "running",
      queue: rest,
      queuePaused: false,
      hasPresetResults: hasPresetResults(task),
      resultMode: "simulated",
      previewKind: previewKindFor(
        first.text,
        task.previewKind || task.demoKind,
      ),
      previewPrompt: first.text,
      extraMessages: [
        ...normalMessages(task.extraMessages),
        { text: first.text, attachments: first.attachments || [] },
      ],
    });
    finishLater();
  };
  const decide = (id, value) => {
    if (!canAnswerPreview(latest.current, "approval", stopping)) return false;
    if (
      !INITIAL_APPROVALS.some((request) => request.id === id) ||
      latest.current.approvalAnswers?.[id]
    )
      return false;
    const next = { ...(latest.current.approvalAnswers || {}), [id]: value };
    latest.current = { ...latest.current, approvalAnswers: next };
    onTaskChange({ approvalAnswers: next, archived: false });
    if (Object.keys(next).length === INITIAL_APPROVALS.length) {
      if (Object.values(next).includes("reject")) {
        onTaskChange(beginPreviewDecisionResult(latest.current, "declined"));
        finishLater();
        emit("已提交拒绝，等待 Agent 返回结果");
      } else {
        onTaskChange({
          status: "running",
          stopPhase: null,
          resultMode: "preset",
        });
        finishLater();
      }
    }
    return true;
  };
  const retryRecovery = () => {
    setRecoveryState("working");
    const id = task.id;
    const expectedStatus = task.status;
    const outcome = expectedStatus === "unknown" ? unknownDemo : recoveryDemo;
    clock.current.work(() => {
      if (latest.current.id !== id) return;
      const patch = resolvePreviewRecovery(
        latest.current,
        expectedStatus,
        outcome,
      );
      if (!patch) return;
      onTaskChange(patch);
      const confirmed = ["matched", "stopped", "completed"].includes(
        patch.recoveryResult,
      );
      setRecoveryState(confirmed ? "idle" : "failed");
      if (confirmed)
        emit("已收到模拟确认，原选择与待发消息保留；没有自动发送。");
    }, 1200);
  };
  const submitAnswer = () => {
    if (!canAnswerPreview(latest.current, "question", stopping)) return;
    const answer = latest.current.answerDraft || {
      choice: "existing",
      note: "",
    };
    if (answer.choice === "explore") {
      clock.current.clearWork();
      onTaskChange({
        status: "done",
        resultMode: "plan",
        archived: false,
        answerDraft: answer,
        answerSubmitted: true,
        queuePaused: true,
      });
      emit("已展示模拟方案，等待你确认后继续");
      return;
    }
    onTaskChange({
      status: "running",
      resultMode: scenarioFor(latest.current) ? "scenario" : "preset",
      stopPhase: null,
      archived: false,
      answerDraft: answer,
      answerSubmitted: true,
    });
    finishLater();
    emit("已提交回答");
  };
  const cancelQuestion = () => {
    if (!canAnswerPreview(latest.current, "question", stopping)) return;
    clock.current.clearWork();
    onTaskChange(beginPreviewDecisionResult(latest.current, "cancelled"));
    finishLater();
    emit("已取消这次回答，等待 Agent 返回结果");
  };
  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      emit("已复制");
    } catch {
      emit("无法复制，请选择文字后复制");
    }
  };
  const queueMove = (index, direction) => {
    const next = [...queue],
      target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onTaskChange({ queue: next });
  };
  const editQueue = (index) => {
    const editing = beginPreviewQueueEdit(latest.current, index);
    if (!editing) return;
    onTaskChange(editing.patch);
    setQueueEdit(editing.edit);
  };
  const addFile = (path) => {
    if (!attachments.includes(path))
      onTaskChange({
        attachments: [...attachments, path],
        draft: text.replace(/@[^\s]*$/, ""),
      });
    setAttachmentsOpen(false);
  };
  useEffect(() => {
    if (!find?.trim() || !transcript.current) {
      setFindMatches(0);
      return;
    }
    const nodes = [
      ...transcript.current.querySelectorAll(
        "p,code,.conv-step-title,h2,.conv-result-files button",
      ),
    ].filter((el) => el.textContent.toLowerCase().includes(find.toLowerCase()));
    setFindMatches(nodes.length);
    for (const node of nodes) node.classList.add("conv-found");
    nodes[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => nodes.forEach((node) => node.classList.remove("conv-found"));
  }, [find, task.id, task.status]);
  const showWork = !isDraft;
  const interactivePreview =
    task.id.startsWith("new-") || task.resultMode === "simulated";
  const previewKind =
    task.previewKind ||
    previewKindFor(task.previewPrompt || task.prompt, task.demoKind);
  const scenario = scenarioFor(task);
  const attachmentFiles = workspace
    ? workspace.files.map((file) => ({
        ...file,
        label: file.path.split("/").pop(),
      }))
    : interactivePreview || !isPresetTask(task)
      ? previewFilesFor(previewKind)
      : scenario?.files || FILES;
  const resultsAvailable = !workspace && !scenario && hasPresetResults(task);
  const scenarioResults =
    Boolean(scenario) &&
    !interactivePreview &&
    task.status === "done" &&
    task.resultMode !== "simulated" &&
    task.resultMode !== "plan";
  const paneTask = pane?.reply || latestArtifactReply(task);
  const paneScenario = scenarioFor(paneTask);
  const paneAvailable =
    paneTask.status === "done" &&
    !["simulated", "plan"].includes(paneTask.resultMode) &&
    Boolean(paneScenario || hasPresetResults(paneTask));
  const panelOpen = workspace ? workspacePanel.open !== false : Boolean(pane);

  return (
    <section
      className={`conv-page ${workspace && panelOpen ? "workspace-open" : ""}`}
    >
      <div className="conv-body">
        <div className="conv-main">
          <header className="conv-header">
            <div className="conv-header-leading">
              {onToggleNavigation && (
                <Button
                  kind="icon"
                  className={
                    "conv-navigation-toggle " +
                    (navigationCollapsed ? "is-collapsed" : "")
                  }
                  aria-label="展开导航"
                  onClick={onToggleNavigation}
                >
                  <SidebarSimple size={18} />
                </Button>
              )}
              {onBack && (
                <Button
                  kind="icon"
                  aria-label="返回"
                  title="返回刚才的页面"
                  onClick={onBack}
                >
                  <ArrowLeft size={18} />
                </Button>
              )}
            </div>
            <div className="conv-title-wrap">
              <h1 title={task.title || "新对话"}>{task.title || "新对话"}</h1>
              <div className="conv-title-context">
                <span>{projectName(task.project)}</span>
                {activity.attention ? (
                  <Badge tone="amber">需要你</Badge>
                ) : task.imported && !task.extraMessages?.length ? (
                  <Badge>{task.readOnly ? "仅可查看" : "历史已带入"}</Badge>
                ) : (
                  <Status value={task.status} />
                )}
              </div>
            </div>
            <div className="conv-header-actions">
              <Button
                kind="icon"
                aria-label="查找当前对话"
                onClick={() => setFind(find === null ? "" : null)}
              >
                <MagnifyingGlass size={19} />
              </Button>
              {!task.imported && (
                <Button
                  className={panelOpen ? "conv-active" : ""}
                  aria-label={panelOpen ? "收起对话内容" : "查看对话内容"}
                  title={panelOpen ? "收起对话内容" : "查看对话内容"}
                  aria-expanded={panelOpen}
                  onClick={() =>
                    workspace
                      ? onTaskChange({
                          workspacePanel: {
                            ...workspacePanel,
                            open: !panelOpen,
                          },
                        })
                      : pane
                        ? setPane(null)
                        : openPane()
                  }
                >
                  <FileText size={17} />
                  <span>
                    {workspace || scenario || interactivePreview
                      ? "内容"
                      : "产物"}
                  </span>
                  {workspace && <Badge>{workspace.files.length}</Badge>}
                  {(resultsAvailable || scenarioResults) && (
                    <Badge>{scenarioResults ? scenario.files.length : 3}</Badge>
                  )}
                </Button>
              )}
              <div className="conv-popover-wrap">
                <Button
                  kind="icon"
                  aria-label="对话操作"
                  onClick={() => setMenu((v) => !v)}
                >
                  <DotsThree size={23} />
                </Button>
                {menu && (
                  <>
                    <button
                      className="conv-dismiss"
                      aria-label="关闭菜单"
                      onClick={() => setMenu(false)}
                    />
                    <div className="conv-menu">
                      <button
                        onClick={() => {
                          setRename(task.title);
                          setMenu(false);
                        }}
                      >
                        <PencilSimple size={16} />
                        重命名
                      </button>
                      <button
                        onClick={() => {
                          copy(
                            readableTranscript(transcript.current, task.title),
                          );
                          setMenu(false);
                        }}
                      >
                        <Copy size={16} />
                        复制对话内容
                      </button>
                      <button
                        disabled={!task.archived && !activity.canArchive}
                        onClick={() => {
                          onTaskChange({ archived: !task.archived });
                          emit(
                            task.archived
                              ? "已移回最近对话"
                              : "已归档，仍可在归档中找到",
                          );
                          setMenu(false);
                        }}
                      >
                        <Archive size={16} />
                        {task.archived ? "移回最近对话" : "归档对话"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>
          {find !== null && (
            <div className="conv-find">
              <MagnifyingGlass size={17} />
              <input
                autoFocus
                aria-label="查找当前对话"
                placeholder="查找当前对话的文字"
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
              <span>
                {find
                  ? findMatches
                    ? "找到相关内容"
                    : "没有匹配内容"
                  : "仅搜索当前已展示内容"}
              </span>
              <Button
                kind="icon"
                aria-label="关闭查找"
                onClick={() => setFind(null)}
              >
                <X size={17} />
              </Button>
            </div>
          )}
          <div
            className="conv-transcript"
            ref={transcript}
            onScroll={(e) => {
              const el = e.currentTarget;
              setShowLatest(
                el.scrollHeight - el.scrollTop - el.clientHeight > 160,
              );
            }}
          >
            <div className="conv-column">
              {agentUnavailable && (
                <div className="conv-source-missing">
                  <Notice tone="amber" title="这条对话的 Agent 当前不可用">
                    新消息与待发消息已暂停，已有内容和草稿保留。正在执行的任务仍可查看、审批或停止。
                  </Notice>
                  <div className="conv-card-actions">
                    <Button
                      onClick={() =>
                        onSettings("agents", {
                          panel: "program",
                          reason:
                            "这段对话的 Agent 当前不可用，请检查程序连接。",
                        })
                      }
                    >
                      打开 Agent 设置
                    </Button>
                  </div>
                </div>
              )}
              {serviceMissing && (
                <div className="conv-source-missing">
                  <Notice tone="amber" title="这条对话的模型来源已不可用">
                    {serviceIssue ||
                      "原服务被删除、地址或接口已改变，或已不再提供这个模型。"}
                    历史内容保留，后续消息已暂停；不会自动更换来源。
                  </Notice>
                  <div className="conv-card-actions">
                    <Button
                      onClick={() =>
                        onSettings(
                          task.accessMode === "api" ? "api" : "agents",
                          {
                            panel: "account",
                            reason:
                              serviceIssue || "请检查这段对话的账号与服务。",
                          },
                        )
                      }
                    >
                      {task.accessMode === "api"
                        ? "管理 API 配置"
                        : "检查 Agent 设置"}
                    </Button>
                    <Button onClick={onNew}>新开对话</Button>
                  </div>
                </div>
              )}
              <MissingIdentity
                task={task}
                onTaskChange={onTaskChange}
                onNew={onNew}
              />
              {task.recoveryRead && (
                <HistoryReading
                  task={task}
                  onTaskChange={onTaskChange}
                  onNew={onNew}
                />
              )}
              {task.status === "recovery" &&
                !task.recoveryRead &&
                !task.identityIncomplete && (
                  <section className="conv-recovery">
                    <div className="conv-card-label">
                      <Badge tone="amber">需要恢复</Badge>
                      <span>原对话可继续查看</span>
                    </div>
                    <h2>恢复后的设置发生了变化</h2>
                    <p>
                      为避免用另一组设置继续工作，已暂停发送。原内容和待发消息都保留着。
                    </p>
                    <div className="conv-compare">
                      <div>
                        <span>原来的设置</span>
                        <strong>{task.originalModel || task.model}</strong>
                        <small>推理等级 · {task.effort || "High"}</small>
                        <small>{task.source || "沿用 Agent 已有设置"}</small>
                      </div>
                      <ArrowUpRight size={20} />
                      <div>
                        <span>Agent 当前返回</span>
                        <strong>{task.currentModel || task.model}</strong>
                        <small className="conv-warning">
                          推理等级 · {task.currentEffort || "Ultra"}
                        </small>
                        <small>{task.source || "沿用 Agent 已有设置"}</small>
                      </div>
                    </div>
                    {recoveryState === "failed" && (
                      <Notice
                        tone="amber"
                        title={
                          task.recoveryResult === "unavailable"
                            ? "本次未能读取原对话"
                            : "仍未恢复原来的设置"
                        }
                      >
                        原内容和待发消息保留，没有发送新消息。可以重试，或明确选择新开对话。
                      </Notice>
                    )}
                    <div className="conv-card-actions">
                      <Button primary onClick={onNew}>
                        新开对话
                      </Button>
                      <Button
                        disabled={recoveryState === "working"}
                        onClick={retryRecovery}
                      >
                        <ArrowClockwise size={15} />
                        {recoveryState === "working" ? "正在恢复…" : "重试恢复"}
                      </Button>
                      <Button
                        kind="text"
                        onClick={() =>
                          onSettings("agents", {
                            panel: "model",
                            reason:
                              "这段对话尚未恢复原来的模型或思考选择。检查后返回原对话重试恢复。",
                          })
                        }
                      >
                        检查 Agent 设置
                      </Button>
                    </div>
                    <small>
                      新对话保留项目选择，不会自动带入旧历史或发送待发消息。
                    </small>
                    <details>
                      <summary>模拟恢复结果</summary>
                      <label>
                        这次读取返回
                        <select
                          aria-label="模拟历史恢复结果"
                          value={recoveryDemo}
                          disabled={recoveryState === "working"}
                          onChange={(event) =>
                            setRecoveryDemo(event.target.value)
                          }
                        >
                          <option value="mismatch">设置仍有差异</option>
                          <option value="matched">原对话与原设置一致</option>
                          <option value="unavailable">
                            读取失败，保留原内容
                          </option>
                        </select>
                      </label>
                      <p>
                        仅演示收到不同结果后的处理，不读取真实历史，也不修改
                        Agent 设置。
                      </p>
                    </details>
                  </section>
                )}
              {task.status === "unknown" && !task.accessTest && (
                <section className="conv-recovery">
                  <div className="conv-card-label">
                    <Badge tone="amber">结果未知</Badge>
                    <span>待发消息已暂停</span>
                  </div>
                  <h2>
                    {task.unknownReason === "admission"
                      ? "这条消息的接纳结果尚未确认"
                      : task.unknownReason === "restart"
                        ? "重新打开后，需要确认上次工作的结果"
                        : task.unknownReason === "connection"
                          ? "执行中连接已中断，结果尚未确认"
                          : "还没有收到停止确认"}
                  </h2>
                  <p>
                    {task.unknownReason === "admission"
                      ? "这条消息可能已开始执行。已固定当时的 Agent 与选择，保留提交内容；确认结果前不能重复发送。"
                      : "任务可能仍在执行。保留当前内容，确认执行情况后再决定下一步。"}
                  </p>
                  {task.interactionExpired && (
                    <p>
                      上次的审批或问题已失效，未提交的回答仍保留。请等待 Agent
                      重新提出请求。
                    </p>
                  )}
                  {recoveryState === "failed" && (
                    <Notice tone="amber" title="仍未收到确认">
                      结果保持未知，没有重复提交任务。
                    </Notice>
                  )}
                  <div className="conv-card-actions">
                    <Button
                      disabled={recoveryState === "working"}
                      onClick={retryRecovery}
                    >
                      <ArrowClockwise size={15} />
                      {recoveryState === "working"
                        ? "正在等待确认…"
                        : ["admission", "restart", "connection"].includes(
                              task.unknownReason,
                            )
                          ? "查询这次请求的结果"
                          : "再次请求停止"}
                    </Button>
                    <Button onClick={() => openPane("logs")}>
                      查看最近活动
                    </Button>
                    <Button
                      kind="text"
                      onClick={() =>
                        onSettings("agents", {
                          panel: "program",
                          reason:
                            "这段工作的结果尚未确认，请检查程序连接后返回继续确认。",
                        })
                      }
                    >
                      检查连接
                    </Button>
                  </div>
                  <details>
                    <summary>模拟确认结果</summary>
                    <label>
                      这次收到
                      <select
                        aria-label="模拟未知请求的确认结果"
                        value={unknownDemo}
                        disabled={recoveryState === "working"}
                        onChange={(event) => setUnknownDemo(event.target.value)}
                      >
                        <option value="unknown">仍未确认</option>
                        <option value="stopped">明确停止确认</option>
                        <option value="completed">明确完成结果</option>
                      </select>
                    </label>
                    <p>
                      只更新原请求的模拟结果，不重新提交任务。确认后待发仍由你决定是否继续。
                    </p>
                  </details>
                </section>
              )}
              {isDraft && (
                <div className="conv-draft-empty">
                  <div className="conv-draft-icon">
                    <AgentIcon name={task.agent} size={36} />
                  </div>
                  <h2>准备好开始了</h2>
                  <p>描述你想在 {projectName(task.project)} 中完成的工作。</p>
                  <span>发送第一条消息后，这条对话的 Agent 与模型将固定。</span>
                </div>
              )}
              {showWork && task.accessTest ? (
                <AccessTestTranscript
                  task={task}
                  copy={copy}
                  onAction={onAccessTestAction}
                />
              ) : (
                showWork && (
                  <ConversationTranscript
                    task={task}
                    stopping={
                      stopping ||
                      (pending && !canAnswerPreview(task, task.status, false))
                    }
                    workspace={workspace}
                    workspacePanel={workspacePanel}
                    onSelectWorkspace={selectWorkspace}
                    onFeedback={feedbackToInput}
                    openPane={openPane}
                    copy={copy}
                    onTaskChange={onTaskChange}
                    onDecision={decide}
                    onSubmitAnswer={submitAnswer}
                    onCancelQuestion={cancelQuestion}
                  />
                )
              )}
              <ExecutionReviewControls
                task={task}
                permissionCapability={permissionCapability}
                onTaskChange={onTaskChange}
                onStopConfirmed={() => {
                  clock.current.dispose();
                  setStopping(false);
                  onTaskChange({
                    status: "stopped",
                    stopPhase: null,
                    terminalConfirmed: true,
                    queuePaused: true,
                  });
                }}
                beforeScenario={() => {
                  clock.current.dispose();
                  setStopping(false);
                }}
              />
            </div>
          </div>
          <div className="conv-composer-area">
            {showLatest && (
              <button
                className="conv-latest"
                type="button"
                onClick={() => {
                  transcript.current?.scrollTo({
                    top: transcript.current.scrollHeight,
                    behavior: "smooth",
                  });
                  setShowLatest(false);
                }}
              >
                <ArrowDown size={14} />
                回到最新
              </button>
            )}

            {task.attachmentsNeedReview && (
              <section
                className="draft-recovery-notice"
                aria-label="线程附件核对"
              >
                <div>
                  <strong>核对恢复的附件</strong>
                  <p>当前输入与待发消息都已保留。确认附件后，由你继续发送。</p>
                </div>
                <Button onClick={() => setAttachmentReviewOpen(true)}>
                  核对附件
                </Button>
              </section>
            )}
            {!workEnabled && (
              <div className="conv-work-paused">
                <Pause size={14} />
                <span>
                  {task.folder ? "此文件夹" : "普通对话"}
                  已暂停发送，草稿与待发消息保留。
                </span>
                {onResumeSending && (
                  <Button onClick={onResumeSending}>恢复发送</Button>
                )}
              </div>
            )}
            {task.permissionChange && (
              <div className="conv-work-paused" role="status">
                <span>
                  {task.permissionChange.phase === "pending"
                    ? "正在确认权限…"
                    : "权限结果未确认，消息尚未发送。"}
                </span>
                {task.permissionChange.phase === "unknown" && (
                  <Button onClick={permission.read}>重新读取权限</Button>
                )}
                {permission.readError && <small>{permission.readError}</small>}
              </div>
            )}
            {queue.length > 0 && (
              <section className="conv-queue">
                <div className="conv-queue-heading">
                  <span>
                    <ListBullets size={16} />
                    <strong>待发消息</strong>
                    <Badge>{queue.length}</Badge>
                    {paused && <Badge tone="amber">已暂停</Badge>}
                  </span>
                  <div>
                    {!paused && (
                      <Button
                        kind="text"
                        onClick={() => onTaskChange({ queuePaused: true })}
                      >
                        <Pause size={13} />
                        暂停
                      </Button>
                    )}
                    {paused && (
                      <Button
                        kind="text"
                        disabled={
                          blocked || pending || isRunning || !workEnabled
                        }
                        onClick={continueQueue}
                      >
                        <Play size={13} />
                        继续发送
                      </Button>
                    )}
                  </div>
                </div>
                {queue.map((item, index) => (
                  <div className="conv-queue-item" key={item.id || index}>
                    <span className="conv-queue-number">{index + 1}</span>
                    <button
                      className="conv-queue-text"
                      type="button"
                      onClick={() => editQueue(index)}
                    >
                      {item.text}
                      <SentAttachments attachments={item.attachments} />
                    </button>
                    <div className="conv-queue-controls">
                      <Button
                        kind="icon"
                        aria-label={`上移第 ${index + 1} 条待发消息`}
                        disabled={index === 0}
                        onClick={() => queueMove(index, -1)}
                      >
                        <ArrowUp size={13} />
                      </Button>
                      <Button
                        kind="icon"
                        aria-label={`下移第 ${index + 1} 条待发消息`}
                        disabled={index === queue.length - 1}
                        onClick={() => queueMove(index, 1)}
                      >
                        <ArrowDown size={13} />
                      </Button>
                      <Button
                        kind="icon"
                        aria-label={`编辑第 ${index + 1} 条待发消息`}
                        onClick={() => editQueue(index)}
                      >
                        <PencilSimple size={13} />
                      </Button>
                      <Button
                        kind="icon"
                        aria-label={`移除第 ${index + 1} 条待发消息`}
                        onClick={() => {
                          onTaskChange({
                            queue: queue.filter((_, i) => i !== index),
                          });
                          emit("已移除这条待发消息");
                        }}
                      >
                        <X size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
                <p>
                  {blocked
                    ? agentUnavailable
                      ? "Agent 恢复可用后，由你决定是否继续发送。"
                      : "恢复后由你决定是否继续发送。"
                    : paused
                      ? "消息仍保留。继续发送不会重复执行已完成的工作。"
                      : "当前任务结束后按顺序发送。你可以先修改、移除或暂停。"}
                </p>
              </section>
            )}
            {task.accessTest ? (
              <div className="conv-import-readonly">
                <strong>固定测试记录</strong>
                <p>
                  这条记录保留测试时的
                  Agent、来源、模型与工作位置。准备页与此处控制同一次操作。
                </p>
                <Button onClick={onReturnToPreparation}>返回准备</Button>
                <Button onClick={onNew}>用此选择新开对话</Button>
              </div>
            ) : task.readOnly ? (
              <div className="conv-import-readonly">
                <strong>
                  {task.importedLocationMissing
                    ? "原工作位置不可用"
                    : "这段历史仅可查看"}
                </strong>
                <p>
                  {task.readOnlyReason ||
                    "这个示例没有继续原对话的能力，内容仍可查看和复制。"}
                </p>
                <Button onClick={onNew}>
                  {task.importedLocationMissing
                    ? "另选位置新开对话"
                    : "用这个 Agent 新开对话"}
                </Button>
                <small>新对话不会自动带入历史，也不会替换原对话的设置。</small>
                {task.draft?.trim() && (
                  <div className="conv-modal-field">
                    <label htmlFor={`readonly-draft-${task.id}`}>
                      保留的草稿
                    </label>
                    <textarea
                      id={`readonly-draft-${task.id}`}
                      aria-label="只读对话中保留的草稿"
                      readOnly
                      value={task.draft}
                      rows={3}
                    />
                    <Button kind="text" onClick={() => copy(task.draft)}>
                      复制草稿
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <ConversationComposer
                task={task}
                permissionCapability={permissionCapability}
                permissionGate={permissionGate}
                onPermissionChange={permission.change}
                text={text}
                attachments={attachments}
                blocked={blocked}
                stopping={stopping}
                workEnabled={workEnabled}
                isRunning={isRunning}
                pending={pending}
                paused={paused && queue.length > 0}
                active={active}
                onTaskChange={onTaskChange}
                onNew={onNew}
                send={send}
                stop={stop}
                addFile={addFile}
                openAttachments={() => setAttachmentsOpen(true)}
                files={attachmentFiles}
              />
            )}
          </div>
        </div>
        {workspace && panelOpen && (
          <WorkspacePanel
            task={task}
            onTaskChange={onTaskChange}
            kind={task.workspaceKind}
            data={workspace}
            panel={workspacePanel}
            onPanelChange={(next) => onTaskChange({ workspacePanel: next })}
            onClose={() =>
              onTaskChange({
                workspacePanel: { ...workspacePanel, open: false },
              })
            }
            onFeedback={feedbackToInput}
            toast={toast}
          />
        )}
        {!workspace && pane && (
          <ArtifactDrawer
            key={task.id}
            task={task}
            onTaskChange={onTaskChange}
            initialTab={pane.tab}
            initialFile={pane.file}
            onClose={() => setPane(null)}
            toast={toast}
            available={paneAvailable}
            scenario={paneScenario}
            status={paneTask.status}
            simulated={paneTask.resultMode === "simulated"}
            plan={paneTask.resultMode === "plan"}
          />
        )}
      </div>
      {active && rename !== null && (
        <Modal
          title="重命名对话"
          onClose={() => setRename(null)}
          footer={
            <>
              <Button onClick={() => setRename(null)}>取消</Button>
              <Button
                primary
                disabled={!rename.trim()}
                onClick={() => {
                  onTaskChange({ title: rename.trim() });
                  setRename(null);
                  emit("已更新对话名称");
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <label className="conv-modal-field">
            对话名称
            <input
              autoFocus
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && rename.trim()) {
                  onTaskChange({ title: rename.trim() });
                  setRename(null);
                }
              }}
            />
          </label>
        </Modal>
      )}
      {active && queueEdit && (
        <Modal
          title="编辑待发消息"
          onClose={() => setQueueEdit(null)}
          footer={
            <>
              <Button onClick={() => setQueueEdit(null)}>取消</Button>
              <Button
                primary
                disabled={
                  !queueEdit.text.trim() &&
                  !queue.find((item) => item.id === queueEdit.id)?.attachments
                    ?.length
                }
                onClick={() => {
                  const result = savePreviewQueueEdit(
                    latest.current,
                    queueEdit,
                  );
                  if (result.error) {
                    emit(result.error);
                    return;
                  }
                  onTaskChange(result.patch);
                  setQueueEdit(null);
                  emit("已更新待发消息，点击继续发送后发送");
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <label className="conv-modal-field">
            消息内容
            <textarea
              autoFocus
              rows={6}
              value={queueEdit.text}
              onChange={(e) =>
                setQueueEdit({ ...queueEdit, text: e.target.value })
              }
            />
          </label>
          <SentAttachments
            attachments={
              queue.find((item) => item.id === queueEdit.id)?.attachments || []
            }
          />
          <p className="conv-modal-note">待发已暂停。修改后点击“继续发送”。</p>
        </Modal>
      )}
      {active && attachmentReviewOpen && (
        <AttachmentRecoveryDialog
          files={threadAttachmentReviewItems(task)}
          onClose={() => setAttachmentReviewOpen(false)}
          onConfirm={(kept) => {
            onTaskChange(confirmThreadAttachments(latest.current, kept));
            setAttachmentReviewOpen(false);
            emit("附件已核对，正文与待发顺序保留，尚未发送");
          }}
        />
      )}
      {active && attachmentsOpen && (
        <Modal title="添加项目文件" onClose={() => setAttachmentsOpen(false)}>
          <p className="conv-modal-note">
            选择要交给 Agent 的文件。这里使用演示项目中的文件。
          </p>
          <div className="conv-attachment-list">
            {attachmentFiles.map((file) => (
              <button
                type="button"
                key={file.path}
                onClick={() => addFile(file.path)}
              >
                <FileText size={20} />
                <span>
                  <strong>{file.label}</strong>
                  <small>{file.path}</small>
                </span>
                {attachments.includes(file.path) ? (
                  <Check size={18} />
                ) : (
                  <ArrowUpRight size={16} />
                )}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
