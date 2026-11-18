import { DecisionLine } from "./PermissionDecisionLine";
import { permissionDecision } from "../runtime/permission_options";
import { audioCapability } from "../runtime/audio_input";
import { SearchDisclosure, TranscriptSearchContext } from "./transcript-search";
import { ConfigurationChangeReview } from "./ConfigurationChangeReview";
import { SessionToolRecovery } from "./SessionToolRecovery";
import { AsyncTasks } from "./AsyncTasks";
import { showToolLocation } from "./showToolLocation";
import { ASYNC_TASKS } from "../runtime/async_task_strings";
import { MessageResendDialog } from "./MessageResendDialog";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { ConnectionAccount } from "./ConnectionAccount";
import { ErrorNotice } from "./ErrorNotice";
import { ArchivedWorkLocationNotice } from "./ArchivedWorkLocationNotice";
import { currentWorkLocationGuidance } from "../runtime/archived_work_location";
import { BrowserReadRequest } from "./BrowserReadRequest";
import { BrowserShareControls } from "./BrowserShareControls";
import { useBrowserSharing } from "../runtime/browser_sharing";
import { browserSharingClient } from "../runtime/browser_sharing_service";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";
import type { RememberedBrowserOwner } from "../runtime/browser_remembered";
import { browserSurfaceGuard } from "../runtime/browser_surface";
/**
 * 会话正文：消息流 + 步骤流 + 审批卡 + 结束行 + 连接横幅 + 消息栏。
 * 渲染数据来自 `runtime/sessions.ts` 的归一化 ThreadState。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowDownIcon,
  GlobeIcon,
  FileHtmlIcon,
  BookOpenIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import { promptCapabilities } from "../runtime/agents";
import { useConnectionHold } from "../runtime/connection_hold";
import { AgentLogo } from "./AgentLogo";
import {
  threads,
  modelConfigOption,
  configValueLabel,
  hasActiveTools,
  toolActivityState,
  type Attachment,
  type PermissionOption,
  type ThreadItem,
  type ThreadState,
  type ToolCallView,
} from "../runtime/sessions";
import { unfinishedStoppedToolCallIds } from "../runtime/stopped_tool_results";
import {
  configCheckMessage,
  configurationConfirmationBusy,
  confirmingMissingModel,
} from "../runtime/config_check";
import { streamTailItem } from "../runtime/session_streams";
import { ReportedDetails } from "./ReportedDetails";
import { CompressionDescription } from "./CompressionDescription";
import { ConfigCheckReview } from "./ConfigCheckReview";
import { useOriginalSessionConfigRecovery } from "./OriginalSessionConfigRecovery";
import { configRecheckBusy } from "../runtime/session_config_recheck";
import { canExplainFailedToolQueue } from "../runtime/queue";
import { FailedToolQueueHint } from "./FailedToolQueueHint";
import { StoppedWorkClose } from "./StoppedWorkClose";
import { composerDrafts, useComposerDraft } from "../runtime/drafts";
import { userMessageDraftAttachments } from "../runtime/message_actions";
import { UserMessageActions } from "./UserMessageActions";
import {
  canInspectToolContent,
  reportedArtifactCounts,
} from "../runtime/reported_artifacts";
import { useContentOwner } from "./useContentOwner";
import { settledRoundResults } from "../runtime/round_result";
import { SettledLine } from "./SettledLine";
import { historyForkableItems } from "../runtime/history_fork_point";
import { COMPACTION } from "../runtime/compaction_strings";
import {
  hasActiveCompaction,
  compactionUncertain,
} from "../runtime/compaction_activity";
import { CompactionCard } from "./CompactionCard";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { UserMessageContent } from "./UserMessageContent";
import { permissionShortcut } from "../runtime/permission_shortcuts";
import { STRINGS } from "../runtime/strings";
import {
  pendingPreparationRead,
  usePreparationChanges,
} from "../runtime/agent_preparation";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import { ArtifactPane, type OpenedFileRequest } from "./ArtifactPane";
import type { AttachmentSearchRequest } from "./AttachmentSearchJump";
import { attachmentSearchSourceCurrent } from "../runtime/attachment_search_source";
import { useFileFeedbackDestination } from "./useFileFeedbackDestination";
import { Composer } from "./Composer";
import { WorkspacePopover } from "./WorkspacePopover";
import { ModelPicker } from "./ModelPicker";
import { SessionOptionsList } from "./SessionOptionsMenu";
import { ReasoningControl } from "./ReasoningControl";
import { configOptionChangeBlocked } from "../runtime/protected_config";
import { useAuthenticationActivity } from "../runtime/authentication";
import { PermissionControl } from "./PermissionControl";
import { listCredentials } from "../runtime/credentials";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { ElicitationCard } from "./ElicitationCard";
import { MessageAttachments, MessageContent } from "./MessageContent";
import {
  ApprovalCard,
  MessageCopyButton,
  PlanBlock,
  RawBlock,
  ToolStep,
  timeLabel,
} from "./thread-items";

/* ── 分组渲染：连续工具步骤合成一个 steps 容器 ── */

function itemBlocks(items: ThreadItem[]): ThreadItem[][] {
  const out: ThreadItem[][] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "tool" && last && last[0]?.kind === "tool") {
      last.push(item);
    } else {
      out.push([item]);
    }
  }
  return out;
}

/* ── 主组件 ── */

export function ThreadView({
  thread,
  active,
  agents,
  onGoSettings,
  onOpened,
  onRecover,
  onNew,
  onNewFromMessage,
  onForkFromMessage,
  header,
  artifactReturnFocusRef,
  contentMode,
  onContentModeChange,
  onBrowserStateChange,
  onBrowserOwnersChange,
  draftComposerRef,
  preparedComposerIsCurrent,
  rememberedBrowserOwner,
  attachmentSearchRequest,
}: {
  attachmentSearchRequest?: AttachmentSearchRequest | null;
  rememberedBrowserOwner?: RememberedBrowserOwner | null;
  draftComposerRef?: React.Ref<HTMLDivElement>;
  preparedComposerIsCurrent?: (() => boolean) | null;
  onBrowserOwnersChange?: (taskKey: string, ownsPages: boolean) => void;
  onBrowserStateChange?: (
    taskKey: string,
    page: BrowserWorkspaceState | null,
  ) => void;
  contentMode?: "files" | "browser";
  onContentModeChange?: (mode: "files" | "browser") => void;
  header?: ReactNode;
  artifactReturnFocusRef?: RefObject<HTMLElement | null>;
  thread: ThreadState;
  active: boolean;
  agents: AgentCardModel[];
  onGoSettings: () => void;
  onOpened: (key: string) => void;
  onRecover?: (key: string) => Promise<void>;
  onNew?: () => void;
  onForkFromMessage?: (item: ThreadItem) => void;
  /** W3-6：从一条用户消息开新对话（宿主负责同上下文预填与草稿冲突）。 */
  onNewFromMessage?: (item: {
    text: string;
    attachments: Attachment[];
  }) => void;
}) {
  const [fileRequest, setFileRequest] = useState<OpenedFileRequest | null>(
    null,
  );
  const fileRequestId = useRef(0);
  const searchRequest = useRef(attachmentSearchRequest);
  searchRequest.current = attachmentSearchRequest;
  const [browserPage, setBrowserPage] = useState<BrowserWorkspaceState | null>(
    null,
  );
  useEffect(() => {
    onBrowserStateChange?.(thread.key, browserPage);
  }, [thread.key, browserPage, onBrowserStateChange]);
  const sharing = useBrowserSharing(
    thread.nativeSessionId
      ? {
          taskKey: thread.key,
          target: {
            agentId: thread.agentId,
            cwd: thread.cwd,
            nativeSessionId: thread.nativeSessionId,
          },
        }
      : null,
    browserPage?.taskKey === thread.key &&
      (!browserPage.localFileName || !!browserPage.previewMode)
      ? browserPage
      : null,
    active,
    browserSharingClient,
    thread.connectionLost,
  );
  const viewBrowser = () => {
    onContentModeChange?.("browser");
    threads.openArtifactPane(thread.key);
  };
  const localArtifactReturnFocus = useRef<HTMLElement | null>(null);
  useConnectionHold(
    active && !thread.connectionLost
      ? {
          agentId: thread.agentId,
          cwd: thread.cwd,
          serviceContext: thread.serviceContext,
          connectionId: thread.connectionId,
        }
      : null,
  );
  usePreparationChanges();
  useAuthenticationActivity(thread.agentId);
  const draftInput = useComposerDraft(`session:${thread.key}`);
  const queueInput = useComposerDraft(`queue-edit:${thread.key}`);
  const readRequired = pendingPreparationRead(thread);
  const draftReadRequired = thread.identity === "draft" && readRequired;
  const artifactReturnFocus =
    artifactReturnFocusRef ?? localArtifactReturnFocus;
  const ownsContent = useContentOwner(thread, active);
  const originalSettings = useOriginalSessionConfigRecovery(
    thread,
    active && !readRequired,
  );
  const feedbackDestination = useFileFeedbackDestination(
    thread,
    active,
    draftComposerRef ? "new" : `session:${thread.key}`,
    preparedComposerIsCurrent,
  );
  const openArtifacts = (roundId: string, opener: HTMLElement) => {
    if (!ownsContent()) return;
    browserSurfaceGuard.runLatest(() => {
      if (!ownsContent()) return;
      onContentModeChange?.("files");
      if (!ownsContent()) return;
      artifactReturnFocus.current = opener;
      threads.openArtifactPane(thread.key, roundId);
    });
  };
  const openFile = (path: string, opener: HTMLElement) => {
    if (!ownsContent()) return;
    const taskKey = thread.key;
    const request = attachmentSearchRequest;
    const matchesSearch = () =>
      !!request &&
      searchRequest.current === request &&
      request.source.threadKey === thread.key &&
      request.source.path === path &&
      opener.closest<HTMLElement>("[data-loaded-message]")?.dataset
        .loadedMessage === request.source.itemId &&
      opener.closest<HTMLElement>("[data-loaded-attachment]")?.dataset
        .loadedAttachment === String(request.source.attachmentIndex) &&
      attachmentSearchSourceCurrent(
        request.source,
        threads.getSnapshot().threads,
        undefined,
        threads.getSnapshot().index,
      );
    const pdfPreview = matchesSearch() ? request?.pdfPreview : undefined;
    browserSurfaceGuard.runLatest(() => {
      if (
        !ownsContent() ||
        !mounted.current ||
        !activeRef.current ||
        recoveryKey.current !== taskKey
      )
        return;
      artifactReturnFocus.current = opener;
      onContentModeChange?.("files");
      if (!ownsContent()) return;
      setFileRequest({
        taskKey,
        cwd: thread.cwd,
        path,
        selection: ++fileRequestId.current,
        pdfSearchTarget:
          pdfPreview && matchesSearch()
            ? {
                ...pdfPreview,
                // Hand off to this explicit content owner, not the retired search UI.
                current: () =>
                  ownsContent() &&
                  searchRequest.current === request &&
                  attachmentSearchSourceCurrent(
                    request!.source,
                    threads.getSnapshot().threads,
                    undefined,
                    threads.getSnapshot().index,
                  ),
              }
            : undefined,
      });
      threads.openArtifactPane(taskKey);
    });
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const requestsRef = useRef<HTMLDivElement | null>(null);
  const viewRequests = () => {
    if (!activeRef.current) return;
    // Restore this target after native hide and the existing inert cleanup.
    artifactReturnFocus.current = requestsRef.current;
    threads.closeArtifactPane(thread.key);
    requestsRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    requestsRef.current?.focus({ preventScroll: true });
  };
  const activeRef = useRef(active);
  activeRef.current = active;
  const recoveryKey = useRef(thread.key);
  recoveryKey.current = thread.key;
  const recoveryRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recoveryRequest.current++;
    };
  }, []);
  const [reconnecting, setReconnecting] = useState(false);
  const recoveryBusy = reconnecting || thread.reconnecting;
  const recover = () => {
    if (
      !activeRef.current ||
      reconnecting ||
      thread.reconnecting ||
      creating ||
      (!thread.historyUnavailable &&
        currentWorkLocationGuidance(thread.cwd)?.kind === "archive")
    )
      return;
    const key = thread.key;
    const request = ++recoveryRequest.current;
    setReconnecting(true);
    const operation = onRecover
      ? onRecover(key)
      : threads.reconnect(key).then((state) => {
          if (
            state &&
            state.key !== key &&
            mounted.current &&
            activeRef.current &&
            recoveryKey.current === key &&
            recoveryRequest.current === request
          )
            onOpened(state.key);
        });
    void operation
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current && recoveryRequest.current === request)
          setReconnecting(false);
      });
  };
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // W3-6 用户消息操作。写回草稿/发送都走既有的草稿与发送归属保护。
  const [resendOpen, setResendOpen] = useState(false);
  const [resendContinued, setResendContinued] = useState(false);
  const prepareResend = (item: { text: string; attachments: Attachment[] }) => {
    if (!activeRef.current) return;
    const key = `resend:${thread.key}`;
    const existing = composerDrafts.read(key);
    const continued = Boolean(existing.text || existing.attachments.length);
    if (!continued)
      composerDrafts.update(key, () => ({
        text: item.text,
        attachments: userMessageDraftAttachments(item.attachments),
      }));
    setResendContinued(continued);
    setResendOpen(true);
  };
  const newFromMessage = (item: {
    text: string;
    attachments: Attachment[];
  }) => {
    if (!activeRef.current) return;
    onNewFromMessage?.(item);
  };
  const [sourceLabel, setSourceLabel] = useState<string>(W.savedSource);
  useEffect(() => {
    let current = true;
    if (!thread.service) return;
    setSourceLabel(W.savedSource);
    void listCredentials()
      .then((items) => {
        if (current)
          setSourceLabel(
            items.find((item) => item.id === thread.service?.id)?.label ??
              STRINGS.service.unavailable,
          );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [thread.service?.id]);
  const agent = useMemo(
    () => agents.find((a) => a.id === thread.agentId) ?? null,
    [agents, thread.agentId],
  );
  const imageOk = promptCapabilities(agent).image;
  const embedContext = promptCapabilities(agent).embeddedContext;

  // 底部跟滚：新条目/流式内容增长时保持在底部（用户上翻则停）。
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const lastItem = streamTailItem(thread.items);
  const lastCompletion = thread.items
    .slice()
    .reverse()
    .find((item) => item.kind === "settled");
  const roundResults = settledRoundResults(thread);
  const streamTail =
    lastItem && "text" in lastItem
      ? `${lastItem.text.length}:${"attachments" in lastItem ? (lastItem.attachments?.length ?? 0) : 0}`
      : lastItem?.kind === "tool"
        ? lastItem.call.status
        : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (active && el && follow.current) el.scrollTop = el.scrollHeight;
  }, [
    active,
    thread.items.length,
    streamTail,
    thread.pendingPermissions,
    thread.pendingElicitations,
    sharing.pendingRequest?.requestId,
  ]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!active || !el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setShowLatest(!follow.current);
  };
  const returnToLatest = () => {
    const el = scrollRef.current;
    if (!activeRef.current || !el) return;
    follow.current = true;
    el.scrollTop = el.scrollHeight;
    setShowLatest(false);
  };

  const [focusedPermission, setFocusedPermission] = useState<string | null>(
    null,
  );
  const decidePermissionOption = (
    requestId: string,
    option: PermissionOption,
  ) => {
    if (!activeRef.current || thread.stopping || thread.stopUnconfirmed) return;
    const decision = permissionDecision(option);
    threads.decidePermission(
      thread.key,
      requestId,
      option.optionId,
      decision.label,
      decision.allow,
      decision.undoable,
    );
  };

  // 审批快捷键（输入框未聚焦时）
  useEffect(() => {
    if (!active) return;
    const permission =
      thread.pendingPermissions.find(
        (p) =>
          p.requestId === focusedPermission &&
          !p.decision &&
          p.status === "pending",
      ) ??
      thread.pendingPermissions.find(
        (p) => !p.decision && p.status === "pending",
      );
    if (!permission || permission.decision) return;
    const onKey = (e: KeyboardEvent) => {
      if (thread.stopping || thread.stopUnconfirmed) return;
      if (scrollRef.current?.closest("[inert]")) return;
      const option = permissionShortcut(
        e,
        activeRef.current,
        permission.options,
      );
      if (option) {
        e.preventDefault();
        decide(option);
      }
    };
    const decide = (option: PermissionOption) => {
      decidePermissionOption(permission.requestId, option);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active,
    thread.pendingPermissions,
    thread.key,
    thread.stopping,
    thread.stopUnconfirmed,
    focusedPermission,
  ]);

  const permissions = thread.pendingPermissions;
  const blocks = itemBlocks(thread.items);
  const forkableItems = onForkFromMessage && historyForkableItems(thread);
  const stoppedToolCalls = unfinishedStoppedToolCallIds(thread);
  const terminalStop = thread.ownedTerminalStop;
  const liveTerminalExitCount =
    terminalStop &&
    terminalStop.connectionId === thread.connectionId &&
    !terminalStop.settledId
      ? terminalStop.terminalIds.size
      : 0;
  const stepActivity = (call: ToolCallView) =>
    toolActivityState(thread, call, stoppedToolCalls);
  const artifactCounts = reportedArtifactCounts(thread);
  const empty =
    thread.items.length === 0 &&
    permissions.length === 0 &&
    !thread.connectionLost;

  const [modelSelection, setModelSelection] = useState<{
    id: string;
    previous: unknown;
    value: string;
  } | null>(null);
  const modelOption = modelConfigOption(thread.configOptions);
  const selectedModel =
    modelSelection &&
    modelOption?.id === modelSelection.id &&
    modelOption.currentValue === modelSelection.previous &&
    modelOption.options.some((item) => item.value === modelSelection.value)
      ? modelSelection
      : null;
  const draftChoices = thread.identity === "draft" && !thread.resumed;
  const choicesUnchecked =
    thread.modelDrift ||
    (thread.configCheck
      ? thread.configCheck.status !== "ready"
      : !draftChoices);
  const serviceModel = thread.service?.model;
  const serviceModelValue = thread.serviceModelValue;
  // The service's display name belongs to this exact wire choice. Keep the
  // original configuration and all values used for selection and saving.
  const displayedModelOption = useMemo(() => {
    if (!modelOption || !serviceModel || !serviceModelValue) return modelOption;
    return {
      ...modelOption,
      options: modelOption.options.map((choice) =>
        choice.value === serviceModelValue
          ? { ...choice, name: serviceModel }
          : choice,
      ),
    };
  }, [modelOption, serviceModel, serviceModelValue]);
  const currentServiceModelLabel =
    serviceModel &&
    serviceModelValue &&
    modelOption?.currentValue === serviceModelValue
      ? serviceModel
      : undefined;
  const modelLabel =
    modelOption && !(choicesUnchecked && modelOption.currentValue == null)
      ? (currentServiceModelLabel ?? configValueLabel(modelOption))
      : choicesUnchecked
        ? STRINGS.repair.unknownModel
        : STRINGS.switcher.defaultModel;
  const pendingCount =
    permissions.length +
    thread.pendingElicitations.length +
    (sharing.pendingRequest ? 1 : 0);
  const recoveryNotice =
    !thread.unrecoverable &&
    !thread.historyUnavailable &&
    Boolean(thread.openError || thread.connectionLost || thread.sourceError);
  const recoveryDetails = (
    <>
      {thread.sourceError && <span>{STRINGS.service.reconnect}</span>}
      {thread.connectionOutcomeUnknown && (
        <span>{STRINGS.thread.connectionLost}</span>
      )}
    </>
  );

  return (
    <div className="thread-body conversation-workspace" ref={bodyRef}>
      <div className="thread-main">
        {header}
        <div className="transcript" ref={scrollRef} onScroll={onScroll}>
          <div className="col">
            {thread.sessionToolRecoveryRequired && (
              <SessionToolRecovery thread={thread} active={active} />
            )}
            {active && (
              <StoppedWorkClose thread={thread} ownsView={ownsContent} failed />
            )}
            {active && thread.stopUnconfirmed && (
              <StoppedWorkClose
                thread={thread}
                ownsView={ownsContent}
                unconfirmed
              />
            )}
            {thread.historicalOutcomeUnknown && (
              <div className="banner" role="status">
                <span>{STRINGS.thread.historicalOutcomeUnknown}</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => threads.acknowledgeHistoricalOutcome(thread)}
                >
                  {STRINGS.thread.acknowledgeHistoricalOutcome}
                </button>
              </div>
            )}
            {thread.openError && !recoveryNotice && (
              <ErrorNotice
                className="banner error-notice"
                title={
                  recoveryBusy
                    ? thread.historyUnavailable
                      ? STRINGS.repair.readingHistory
                      : STRINGS.thread.reconnecting
                    : thread.unrecoverable
                      ? STRINGS.thread.unrecoverable
                      : thread.historyUnavailable
                        ? STRINGS.repair.historyFailed
                        : STRINGS.thread.openFailed
                }
                message={recoveryBusy ? undefined : thread.openError}
              >
                {recoveryDetails}
                <span className="b-act">
                  {thread.historyUnavailable ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={recoveryBusy || creating}
                      onClick={recover}
                    >
                      {recoveryBusy
                        ? STRINGS.repair.readingHistory
                        : STRINGS.repair.retryHistory}
                    </button>
                  ) : thread.unrecoverable ? (
                    <span className="b-note">
                      {STRINGS.thread.unrecoverableHint}
                    </span>
                  ) : null}
                </span>
              </ErrorNotice>
            )}
            {(thread.modelDrift ||
              thread.configError ||
              thread.unrecoverable ||
              thread.historyUnavailable) && (
              <div className="banner config-guard" role="status">
                {thread.configError && (
                  <span className="config-guard-message">
                    {STRINGS.repair.recheckConfigFailed}
                  </span>
                )}
                {thread.modelDrift && (
                  <span className="config-guard-message">
                    {configCheckMessage(
                      thread.configCheck,
                      thread.configOptions,
                    )}
                  </span>
                )}
                {thread.modelDrift && (
                  <ConfigCheckReview
                    check={thread.configCheck}
                    options={thread.configOptions}
                  />
                )}
                {originalSettings.action}
                {thread.modelDrift &&
                  (thread.configCheck?.status === "confirmation_required" ||
                    thread.configCheck?.status === "record_failed") && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={configurationConfirmationBusy(thread)}
                      onClick={() => void threads.confirmConfig(thread.key)}
                    >
                      {thread.configuring
                        ? STRINGS.repair.confirmingConfig
                        : thread.configCheck.status === "record_failed"
                          ? STRINGS.repair.retryConfigRecord
                          : confirmingMissingModel(thread.configCheck)
                            ? STRINGS.repair.confirmCurrentModel
                            : STRINGS.repair.confirmConfig}
                    </button>
                  )}
                {(thread.modelDrift || thread.configError) &&
                  !thread.unrecoverable &&
                  !thread.historyUnavailable && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={configRecheckBusy(thread)}
                      onClick={() =>
                        void threads
                          .recheckConfig(thread.key)
                          .catch(() => undefined)
                      }
                    >
                      {thread.reconnecting
                        ? STRINGS.repair.recheckingConfig
                        : STRINGS.repair.recheckConfig}
                    </button>
                  )}
                {(thread.modelDrift ||
                  thread.unrecoverable ||
                  thread.historyUnavailable) && (
                  <>
                    <span className="config-guard-message">
                      {readRequired
                        ? C.readRequired
                        : STRINGS.repair.newDraftHint}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={creating || recoveryBusy}
                      onClick={() => {
                        if (creating || reconnecting || thread.reconnecting)
                          return;
                        if (pendingPreparationRead(thread)) {
                          onGoSettings();
                          return;
                        }
                        const key = thread.key;
                        const request = ++recoveryRequest.current;
                        const ownsAction = () =>
                          mounted.current &&
                          recoveryKey.current === key &&
                          recoveryRequest.current === request;
                        setCreating(true);
                        setCreateError(null);
                        void threads
                          .newAfterRecoveryFailure(key)
                          .then((draft) => {
                            if (ownsAction() && activeRef.current)
                              onOpened(draft.key);
                          })
                          .catch(() => {
                            if (ownsAction() && activeRef.current)
                              setCreateError(STRINGS.repair.newDraftFailed);
                          })
                          .finally(() => {
                            if (ownsAction()) setCreating(false);
                          });
                      }}
                    >
                      {creating
                        ? STRINGS.repair.newDraftBusy
                        : STRINGS.repair.newDraft}
                    </button>
                    {createError && <span role="alert">{createError}</span>}
                  </>
                )}
              </div>
            )}
            {originalSettings.dialog}
            {!thread.running && hasActiveCompaction(thread) && (
              <div className="banner" role="status">
                {compactionUncertain(thread)
                  ? COMPACTION.unknown
                  : COMPACTION.inProgress}
              </div>
            )}
            {!thread.running && hasActiveTools(thread) && (
              <div className="banner" role="status">
                {lastCompletion?.status === "stopped"
                  ? STRINGS.thread.toolsAfterStop
                  : STRINGS.thread.toolsAfterReply}
                {active && lastCompletion?.status === "stopped" && (
                  <StoppedWorkClose thread={thread} ownsView={ownsContent} />
                )}
                {active &&
                  lastCompletion?.status === "failed" &&
                  !draftReadRequired &&
                  !draftInput.sendPending &&
                  !draftInput.pendingConversation &&
                  !queueInput.queueEdit &&
                  canExplainFailedToolQueue(thread) && (
                    <FailedToolQueueHint thread={thread} />
                  )}
              </div>
            )}
            <AsyncTasks
              thread={thread}
              active={active}
              onShowTool={(tool) => {
                if (ownsContent()) showToolLocation(scrollRef.current, tool.id);
              }}
            />
            {empty && !thread.openError && (
              <div className="who">{STRINGS.thread.draftHint}</div>
            )}
            {blocks.map((block) => {
              const first = block[0]!;
              if (first.kind === "tool") {
                return (
                  <SearchDisclosure key={first.id} className="workspace-steps">
                    <summary>
                      <BookOpenIcon size={15} aria-hidden="true" />
                      <span>{T.process}</span>
                      <small>{T.stepCount(block.length)}</small>
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          stepActivity(item.call) === "active" &&
                          item.call.status === "in_progress",
                      ) && (
                        <span className="workspace-step-running">
                          {W.stepsRunning}
                        </span>
                      )}
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          stepActivity(item.call) === "active" &&
                          item.call.status === "pending",
                      ) && (
                        <span className="workspace-step-running">
                          {W.stepsPending}
                        </span>
                      )}
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          stepActivity(item.call) === "unknown",
                      ) && <span>{STRINGS.thread.toolResultUnknown}</span>}
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          stepActivity(item.call) === "finished" &&
                          item.call.status === "failed",
                      ) && (
                        <span className="workspace-step-failed">
                          {W.stepsFailed}
                        </span>
                      )}
                      <CaretRightIcon
                        className="workspace-step-caret"
                        size={13}
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="steps">
                      {block.map(
                        (item) =>
                          item.kind === "tool" && (
                            <ToolStep
                              key={item.id}
                              call={item.call}
                              transcriptItemId={item.id}
                              onOpenFile={openFile}
                              activity={stepActivity(item.call)}
                              onOpenArtifacts={
                                canInspectToolContent(
                                  item.call,
                                  artifactCounts.get(item.id),
                                )
                                  ? (event) =>
                                      openArtifacts(
                                        item.id,
                                        event.currentTarget,
                                      )
                                  : undefined
                              }
                            />
                          ),
                      )}
                    </div>
                  </SearchDisclosure>
                );
              }
              switch (first.kind) {
                case "user":
                  return (
                    <div
                      key={first.id}
                      data-loaded-message={first.id}
                      tabIndex={-1}
                      className="workspace-message-user"
                    >
                      <div className="who">
                        {STRINGS.thread.you} · {timeLabel(first.time)}
                        {first.text && <MessageCopyButton text={first.text} />}
                        {(first.text || first.attachments.length > 0) && (
                          <UserMessageActions
                            text={first.text}
                            onForkFromMessage={
                              onForkFromMessage && forkableItems?.has(first)
                                ? () => onForkFromMessage(first)
                                : undefined
                            }
                            disabled={!active}
                            onEditResend={() => prepareResend(first)}
                            onSendAgain={() => prepareResend(first)}
                            onNewFromMessage={
                              onNewFromMessage
                                ? () => newFromMessage(first)
                                : undefined
                            }
                          />
                        )}
                      </div>
                      <UserMessageContent
                        text={first.text}
                        historical={first.time === 0}
                      />
                      <MessageAttachments
                        attachments={first.attachments}
                        onOpenFile={openFile}
                      />
                      <ReportedDetails details={first.reportedDetails} />
                    </div>
                  );
                case "agent":
                  return (
                    <div
                      key={first.id}
                      data-loaded-message={first.id}
                      tabIndex={-1}
                      className="workspace-message-agent"
                    >
                      <div className="who">
                        {agent && <AgentLogo card={agent} />}
                        {agent?.name ?? thread.agentId} ·{" "}
                        {timeLabel(first.time)}
                        {first.text && <MessageCopyButton text={first.text} />}
                        {(onNewFromMessage || onForkFromMessage) &&
                          (first.text ||
                            (first.attachments?.length ?? 0) > 0) && (
                            <UserMessageActions
                              text={first.text}
                              onForkFromMessage={
                                onForkFromMessage && forkableItems?.has(first)
                                  ? () => onForkFromMessage(first)
                                  : undefined
                              }
                              disabled={!active}
                              onNewFromMessage={
                                onNewFromMessage
                                  ? () =>
                                      newFromMessage({
                                        text: first.text,
                                        attachments: first.attachments ?? [],
                                      })
                                  : undefined
                              }
                            />
                          )}
                      </div>
                      <div className="assistant">
                        <MessageContent
                          source={first}
                          text={first.text}
                          attachments={first.attachments}
                          contentOrder={first.contentOrder}
                          onOpenFile={openFile}
                        />
                        <CompressionDescription
                          details={first.reportedDetails}
                        />
                        {thread.running && first.streaming && (
                          <span className="caret" />
                        )}
                      </div>
                      <ReportedDetails details={first.reportedDetails} />
                    </div>
                  );
                case "thought":
                  return (
                    <SearchDisclosure
                      key={first.id}
                      className={`thinking-block${thread.running && first.streaming ? " streaming" : ""}`}
                    >
                      <summary>{STRINGS.thread.thinking}</summary>
                      <p data-find-block>{first.text}</p>
                      <ReportedDetails details={first.reportedDetails} />
                    </SearchDisclosure>
                  );
                case "plan":
                  return (
                    <div key={first.id}>
                      <PlanBlock entries={first.entries} />
                      <ReportedDetails details={first.reportedDetails} />
                    </div>
                  );
                case "compaction":
                  return (
                    <div key={first.id}>
                      <CompactionCard item={first} onOpenFile={openFile} />
                      <ReportedDetails details={first.reportedDetails} />
                    </div>
                  );
                case "decision":
                  return (
                    <DecisionLine
                      key={first.id}
                      decision={{ ...first, undoable: false }}
                      onUndo={() => {}}
                    />
                  );
                case "settled":
                  return (
                    <SettledLine
                      key={first.id}
                      item={first}
                      result={roundResults.get(first.id)}
                      artifactCount={
                        artifactCounts.get(first.id) ?? first.artifactCount
                      }
                      onOpenArtifacts={(event) =>
                        openArtifacts(first.id, event.currentTarget)
                      }
                    />
                  );
                case "raw":
                  return (
                    <div key={first.id}>
                      <RawBlock
                        update={first.update}
                        label={
                          first.label === "notification"
                            ? STRINGS.thread.rawNotification
                            : first.label === "asyncTaskUpdate"
                              ? ASYNC_TASKS.update
                              : undefined
                        }
                      />
                      <ReportedDetails details={first.reportedDetails} />
                    </div>
                  );
                case "notice":
                  return (
                    <div key={first.id} className="auth-note" role="status">
                      {first.message}
                    </div>
                  );
                default:
                  return null;
              }
            })}
            {liveTerminalExitCount > 0 && (
              <div className="settled" role="status">
                {STRINGS.thread.ownedTerminalExit(liveTerminalExitCount)}
              </div>
            )}
            <ReportedDetails details={thread.reportedDetails} />
            <div
              ref={requestsRef}
              className="workspace-requests"
              tabIndex={-1}
              onFocus={(event) => {
                if (event.target === event.currentTarget)
                  event.currentTarget.scrollIntoView({
                    block: "end",
                    behavior: "smooth",
                  });
              }}
            >
              <BrowserReadRequest sharing={sharing} onViewPage={viewBrowser} />
              {permissions.map((permission) => (
                <div
                  key={permission.requestId}
                  tabIndex={0}
                  onFocus={() => setFocusedPermission(permission.requestId)}
                  onClick={() => setFocusedPermission(permission.requestId)}
                >
                  {permission.error && (
                    <div role="alert" className="auth-note">
                      {permission.error}
                    </div>
                  )}
                  {permission.decision ? (
                    <DecisionLine
                      decision={permission.decision}
                      submitting={
                        permission.status === "submitting" ||
                        (permission.status === "pending" &&
                          !permission.decision.undoable)
                      }
                      onUndo={() =>
                        threads.undoPermissionDecision(
                          thread.key,
                          permission.requestId,
                        )
                      }
                    />
                  ) : (
                    <ApprovalCard
                      disabled={thread.stopping || thread.stopUnconfirmed}
                      statusLabel={
                        thread.stopping
                          ? R.stopWaiting
                          : thread.stopUnconfirmed
                            ? R.stopUnknown
                            : undefined
                      }
                      title={permission.title}
                      kind={permission.kind}
                      locations={permission.locations}
                      rawInput={permission.toolCallSnapshot?.rawInput}
                      reportedToolInput={permission.reportedToolInput}
                      terminalCommand={permission.terminalCommand}
                      options={
                        permission.status === "pending"
                          ? permission.options
                          : []
                      }
                      onPick={(option) =>
                        decidePermissionOption(permission.requestId, option)
                      }
                    />
                  )}
                </div>
              ))}
              {thread.pendingElicitations.map((request) => (
                <ElicitationCard
                  disabled={thread.stopping}
                  acceptanceDisabled={thread.stopUnconfirmed}
                  statusLabel={
                    thread.stopping
                      ? R.stopWaiting
                      : thread.stopUnconfirmed
                        ? R.stopUnknown
                        : undefined
                  }
                  key={request.requestId}
                  request={request}
                  agentName={agent?.name ?? thread.agentId}
                  onChange={(name, value) =>
                    threads.setElicitationValue(
                      thread.key,
                      request.requestId,
                      name,
                      value,
                    )
                  }
                  onRespond={(action, values) =>
                    void threads.respondElicitation(
                      thread.key,
                      request.requestId,
                      action,
                      values,
                    )
                  }
                />
              ))}
            </div>
          </div>
        </div>
        {pendingCount > 0 && (
          <div className="workspace-request-alert" role="status">
            <span>
              {thread.stopping
                ? R.stopWaiting
                : thread.stopUnconfirmed
                  ? R.stopUnknown
                  : W.requestPending(pendingCount)}
            </span>
            <button type="button" onClick={viewRequests}>
              {W.viewRequests}
            </button>
          </div>
        )}
        <div className="composer-wrap">
          {active && showLatest && (
            <button
              type="button"
              className="workspace-latest"
              onClick={returnToLatest}
            >
              <ArrowDownIcon size={14} aria-hidden="true" />
              {T.latest}
            </button>
          )}
          <FileFeedbackDrafts
            key={thread.key}
            threadKey={thread.key}
            feedbackDestination={feedbackDestination}
          />
          {recoveryNotice && (
            <ArchivedWorkLocationNotice
              cwd={thread.cwd}
              active={active}
              archiveDetails={recoveryDetails}
              className="banner error-notice"
              role="status"
              title={
                recoveryBusy
                  ? STRINGS.thread.reconnecting
                  : thread.openError
                    ? STRINGS.thread.openFailed
                    : thread.connectionOutcomeUnknown || thread.sourceError
                      ? STRINGS.thread.needYou
                      : undefined
              }
              message={
                recoveryBusy
                  ? undefined
                  : thread.openError
                    ? thread.openError
                    : thread.connectionOutcomeUnknown || thread.sourceError
                      ? undefined
                      : thread.connectionCloseReason === "idle"
                        ? STRINGS.thread.connectionStandby
                        : thread.connectionCloseReason === "user"
                          ? STRINGS.thread.connectionDisconnected
                          : STRINGS.thread.connectionIdle
              }
            >
              {recoveryDetails}
              <span className="b-act">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={recoveryBusy || creating}
                  onClick={recover}
                >
                  {recoveryBusy
                    ? STRINGS.thread.reconnecting
                    : STRINGS.thread.reconnect}
                </button>
              </span>
            </ArchivedWorkLocationNotice>
          )}
          {draftComposerRef ? (
            <div className="prepared-composer-host" ref={draftComposerRef} />
          ) : (
            <Composer
              contextChips={
                browserPage?.taskKey === thread.key &&
                browserPage.phase === "ready" ? (
                  <button
                    type="button"
                    className="desktop-page-chip"
                    title={browserPage.url}
                    onClick={viewBrowser}
                  >
                    {browserPage.localFileName ? (
                      <FileHtmlIcon size={14} aria-hidden="true" />
                    ) : (
                      <GlobeIcon size={14} aria-hidden="true" />
                    )}
                    {browserPage.localFileName ?? W.currentWebpage}
                  </button>
                ) : null
              }
              thread={thread}
              active={active}
              editableWhenDisabled
              autofocus={active}
              draftKey={`session:${thread.key}`}
              imageEnabled={imageOk}
              audioEnabled={audioCapability(agent?.handshake)}
              embedContext={embedContext}
              onGoSettings={onGoSettings}
              suppressThreadOpenError={
                recoveryNotice || Boolean(thread.openError)
              }
              disabled={draftReadRequired}
              note={draftReadRequired ? C.readRequired : undefined}
              prepareAction={draftReadRequired ? onGoSettings : undefined}
              onSend={
                thread.identity === "draft"
                  ? async (blocks, submitted) => {
                      // Composer calls after attachments and draft persistence settle.
                      if (
                        thread.connectionLost ||
                        threads.thread(thread.key) !== thread
                      )
                        return false;
                      if (
                        thread.identity === "draft" &&
                        pendingPreparationRead(thread)
                      )
                        throw new Error(C.readRequired);
                      await threads.send(thread.key, blocks, {
                        key: `session:${thread.key}`,
                        value: submitted,
                      });
                    }
                  : undefined
              }
              controls={
                <>
                  <WorkspacePopover
                    title={W.modelChoice}
                    disabled={!active}
                    label={
                      <>
                        {agent && <AgentLogo card={agent} />}
                        <span>{agent?.name ?? thread.agentId}</span>
                        <span className="workspace-identity-model">
                          {modelLabel}
                        </span>
                      </>
                    }
                  >
                    <dl className="workspace-identity">
                      <dt>{STRINGS.empty.agentLabel}</dt>
                      <dd>{agent?.name ?? thread.agentId}</dd>
                      <dt>{STRINGS.service.source}</dt>
                      <dd>{thread.service ? sourceLabel : W.existingSource}</dd>
                      <dt>
                        {choicesUnchecked
                          ? W.returnedModel
                          : STRINGS.switcher.modelLabel}
                      </dt>
                      <dd>{modelLabel}</dd>
                    </dl>
                    {thread.connectionId && (
                      <ConnectionAccount
                        thread={thread}
                        agentId={thread.agentId}
                        cwd={thread.cwd}
                        connectionId={thread.connectionId}
                        source={thread.service?.id}
                        active={active && !thread.connectionLost}
                      />
                    )}
                    {!draftReadRequired && !choicesUnchecked && modelOption && (
                      <ModelPicker
                        option={
                          selectedModel
                            ? {
                                ...(displayedModelOption ?? modelOption),
                                currentValue: selectedModel.value,
                              }
                            : displayedModelOption
                        }
                        readOnlyLabel={currentServiceModelLabel}
                        disabled={configOptionChangeBlocked(
                          thread,
                          modelOption.id,
                        )}
                        onPick={(value) => {
                          if (
                            thread.identity === "draft" &&
                            pendingPreparationRead(thread)
                          )
                            return;
                          if (configOptionChangeBlocked(thread, modelOption.id))
                            return;
                          setModelSelection(
                            value === modelOption.currentValue
                              ? null
                              : {
                                  id: modelOption.id,
                                  previous: modelOption.currentValue,
                                  value,
                                },
                          );
                        }}
                      />
                    )}
                    {!draftReadRequired &&
                      !choicesUnchecked &&
                      modelOption &&
                      selectedModel && (
                        <ConfigurationChangeReview
                          thread={thread}
                          option={displayedModelOption ?? modelOption}
                          value={selectedModel.value}
                          onCancel={() => setModelSelection(null)}
                          onSaved={() => setModelSelection(null)}
                        />
                      )}
                    {!draftReadRequired && (
                      <SessionOptionsList thread={thread} composer />
                    )}
                    <p className="workspace-control-note">
                      {choicesUnchecked
                        ? (configCheckMessage(
                            thread.configCheck,
                            thread.configOptions,
                          ) ?? W.settingsUnchecked)
                        : draftChoices
                          ? W.settingsDraft
                          : W.settingsFixed}
                    </p>
                    {onNew && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={onNew}
                      >
                        {W.newWithOtherSettings}
                      </button>
                    )}
                  </WorkspacePopover>
                  {!draftReadRequired && (
                    <ReasoningControl thread={thread} inactive={!active} />
                  )}
                  {!draftReadRequired && (
                    <PermissionControl thread={thread} inactive={!active} />
                  )}
                </>
              }
            />
          )}
        </div>
      </div>
      {active && resendOpen && (
        <MessageResendDialog
          thread={thread}
          imageEnabled={imageOk}
          audioEnabled={audioCapability(agent?.handshake)}
          embedContext={embedContext}
          continued={resendContinued}
          onClose={() => setResendOpen(false)}
          onGoSettings={onGoSettings}
        />
      )}
      <TranscriptSearchContext.Provider value={false}>
        <ArtifactPane
          thread={thread}
          feedbackDestination={feedbackDestination}
          rememberedBrowserOwner={rememberedBrowserOwner}
          active={active}
          open={thread.artifactPaneOpen}
          contentMode={contentMode}
          onContentModeChange={onContentModeChange}
          onBrowserStateChange={setBrowserPage}
          onBrowserOwnersChange={(owns) =>
            onBrowserOwnersChange?.(thread.key, owns)
          }
          fileRequest={fileRequest}
          browserToolbar={
            <BrowserShareControls
              sharing={sharing}
              page={browserPage}
              onViewRequest={viewRequests}
            />
          }
          returnFocusRef={artifactReturnFocus}
        />
      </TranscriptSearchContext.Provider>
    </div>
  );
}
