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
  type MouseEventHandler,
} from "react";
import {
  ArrowDownIcon,
  BookOpenIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import { promptCapabilities } from "../runtime/agents";
import { AgentLogo } from "./AgentLogo";
import {
  threads,
  paneCards,
  modelConfigOption,
  configValueLabel,
  hasActiveTools,
  toolActivityState,
  type PermissionOption,
  type ThreadItem,
  type ThreadState,
} from "../runtime/sessions";
import { configCheckMessage } from "../runtime/config_check";
import { ConfigCheckReview } from "./ConfigCheckReview";
import { artifactRoundCounts } from "../runtime/artifact_view";
import { settledRoundResults, type RoundResult } from "../runtime/round_result";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { permissionShortcut } from "../runtime/permission_shortcuts";
import { STRINGS } from "../runtime/strings";
import {
  pendingPreparationRead,
  usePreparationChanges,
} from "../runtime/agent_preparation";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";
import { ArtifactPane } from "./ArtifactPane";
import { Composer } from "./Composer";
import { WorkspacePopover } from "./WorkspacePopover";
import { ModelPicker } from "./ModelPicker";
import { SessionOptionsList } from "./SessionOptionsMenu";
import { ReasoningControl } from "./ReasoningControl";
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

function SettledLine({
  item,
  artifactCount,
  result,
  onOpenArtifacts,
}: {
  item: Extract<ThreadItem, { kind: "settled" }>;
  artifactCount: number;
  result?: RoundResult;
  onOpenArtifacts: MouseEventHandler<HTMLButtonElement>;
}) {
  const label =
    item.status === "done"
      ? result === "none"
        ? STRINGS.thread.noResult
        : result === "pending"
          ? STRINGS.thread.resultPending
          : result === "tool"
            ? STRINGS.thread.ended
            : STRINGS.thread.done
      : item.status === "stopped"
        ? STRINGS.thread.stopped
        : item.status === "unknown"
          ? STRINGS.thread.unknown
          : STRINGS.thread.failed;
  const cls =
    item.status === "done"
      ? result === "none"
        ? "warn"
        : result === "tool" || result === "pending"
          ? undefined
          : "ok"
      : item.status === "unknown"
        ? "warn"
        : "no";
  const reasonLabel =
    item.stopReason && item.stopReason !== "end_turn"
      ? STRINGS.thread.stopReasonLabel(item.stopReason)
      : null;
  return (
    <>
      <div className="settled">
        <span className={cls}>
          {item.status === "done"
            ? result === "none"
              ? "! "
              : result === "pending"
                ? "… "
                : result === "tool"
                  ? "· "
                  : "✓ "
            : item.status === "stopped"
              ? "■ "
              : "✗ "}
          {label}
        </span>
        {reasonLabel && reasonLabel !== label && (
          <span className="tick">{reasonLabel}</span>
        )}
        {item.error && <span className="no">{item.error}</span>}
        <span>{timeLabel(item.time)}</span>
      </div>
      {item.status === "done" && result === "none" && (
        <p className="completion-note" role="status">
          {STRINGS.thread.noResultNote}
        </p>
      )}
      {artifactCount > 0 && (
        <button
          type="button"
          className="round-sum round-artifacts"
          onClick={onOpenArtifacts}
        >
          {STRINGS.thread.roundArtifacts(artifactCount)}
        </button>
      )}
    </>
  );
}

function DecisionLine({
  decision,
  onUndo,
  submitting = false,
}: {
  decision: { label: string; allow: boolean; undoable: boolean };
  onUndo: () => void;
  submitting?: boolean;
}) {
  const [left, setLeft] = useState(5);
  useEffect(() => {
    if (!decision.undoable) return;
    const timer = window.setInterval(
      () => setLeft((v) => Math.max(0, v - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [decision.undoable]);
  return (
    <div className="settled">
      <span
        className={
          submitting || decision.undoable
            ? undefined
            : decision.allow
              ? "ok"
              : "no"
        }
      >
        {!submitting && !decision.undoable && (decision.allow ? "✓ " : "✗ ")}
        {submitting
          ? STRINGS.repair.interactionSubmitting
          : decision.undoable
            ? STRINGS.thread.decisionWaiting
            : decision.label}
      </span>
      {decision.undoable && (
        <button type="button" className="undo" onClick={onUndo}>
          {STRINGS.thread.undo} {STRINGS.thread.secondsLeft(left)}
        </button>
      )}
    </div>
  );
}

/* ── 主组件 ── */

export function ThreadView({
  thread,
  active,
  agents,
  onGoSettings,
  onOpened,
  onNew,
  header,
  artifactReturnFocusRef,
}: {
  header?: ReactNode;
  artifactReturnFocusRef?: RefObject<HTMLElement | null>;
  thread: ThreadState;
  active: boolean;
  agents: AgentCardModel[];
  onGoSettings: () => void;
  onOpened: (key: string) => void;
  onNew?: () => void;
}) {
  const localArtifactReturnFocus = useRef<HTMLElement | null>(null);
  usePreparationChanges();
  const readRequired = pendingPreparationRead(thread);
  const draftReadRequired = thread.identity === "draft" && readRequired;
  const artifactReturnFocus =
    artifactReturnFocusRef ?? localArtifactReturnFocus;
  const openArtifacts = (roundId: string, opener: HTMLElement) => {
    artifactReturnFocus.current = opener;
    threads.openArtifactPane(thread.key, roundId);
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const requestsRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [reconnecting, setReconnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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
  const lastItem = thread.items[thread.items.length - 1];
  const lastCompletion = thread.items
    .slice()
    .reverse()
    .find((item) => item.kind === "settled");
  const roundResults = settledRoundResults(thread);
  const streamTail =
    lastItem && "text" in lastItem
      ? lastItem.text.length
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
    const label =
      option.kind === "allow_once"
        ? STRINGS.thread.approved(option.name)
        : option.kind === "allow_always"
          ? STRINGS.thread.approvedRemember(option.name)
          : STRINGS.thread.rejected;
    threads.decidePermission(
      thread.key,
      requestId,
      option.optionId,
      label,
      option.kind.startsWith("allow"),
      option.kind === "allow_always",
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
      if (thread.stopping) return;
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
  const artifactCounts = artifactRoundCounts(thread);
  const empty =
    thread.items.length === 0 &&
    permissions.length === 0 &&
    !thread.connectionLost;

  const modelOption = modelConfigOption(thread.configOptions);
  const draftChoices = thread.identity === "draft" && !thread.resumed;
  const choicesUnchecked =
    thread.modelDrift ||
    (thread.configCheck
      ? thread.configCheck.status !== "ready"
      : !draftChoices);
  const modelLabel =
    modelOption && !(choicesUnchecked && modelOption.currentValue == null)
      ? configValueLabel(modelOption)
      : choicesUnchecked
        ? STRINGS.repair.unknownModel
        : STRINGS.switcher.defaultModel;
  const pendingCount = permissions.length + thread.pendingElicitations.length;

  return (
    <div className="thread-body conversation-workspace">
      <div className="thread-main">
        {header}
        <div className="transcript" ref={scrollRef} onScroll={onScroll}>
          <div className="col">
            {thread.openError && (
              <div className="banner">
                <span className="b-tag">
                  {thread.unrecoverable
                    ? STRINGS.thread.unrecoverable
                    : STRINGS.thread.openFailed}
                </span>
                <span>{thread.openError}</span>
                <span className="b-act">
                  {thread.unrecoverable ? (
                    <span className="b-note">
                      {STRINGS.thread.unrecoverableHint}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={onGoSettings}
                    >
                      {STRINGS.empty.goSettings}
                    </button>
                  )}
                </span>
              </div>
            )}
            {!thread.unrecoverable &&
              (thread.connectionLost || thread.sourceError) && (
                <div className="banner">
                  {(thread.connectionOutcomeUnknown || thread.sourceError) && (
                    <span className="b-tag">{STRINGS.thread.needYou}</span>
                  )}
                  <span>
                    {thread.sourceError
                      ? STRINGS.service.reconnect
                      : thread.connectionOutcomeUnknown
                        ? STRINGS.thread.connectionLost
                        : STRINGS.thread.connectionIdle}
                  </span>
                  <span className="b-act">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={reconnecting}
                      onClick={() => {
                        setReconnecting(true);
                        void threads
                          .reconnect(thread.key)
                          .finally(() => setReconnecting(false));
                      }}
                    >
                      {reconnecting
                        ? STRINGS.thread.reconnecting
                        : STRINGS.thread.reconnect}
                    </button>
                  </span>
                </div>
              )}
            {(thread.modelDrift || thread.unrecoverable) && (
              <div className="banner config-guard" role="status">
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
                {thread.modelDrift &&
                  (thread.configCheck?.status === "confirmation_required" ||
                    thread.configCheck?.status === "record_failed") && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={thread.configuring || thread.running}
                      onClick={() => void threads.confirmConfig(thread.key)}
                    >
                      {thread.configuring
                        ? STRINGS.repair.confirmingConfig
                        : thread.configCheck.status === "record_failed"
                          ? STRINGS.repair.retryConfigRecord
                          : STRINGS.repair.confirmConfig}
                    </button>
                  )}
                <span className="config-guard-message">
                  {readRequired ? C.readRequired : STRINGS.repair.newDraftHint}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={creating}
                  onClick={() => {
                    if (creating) return;
                    if (pendingPreparationRead(thread)) {
                      onGoSettings();
                      return;
                    }
                    setCreating(true);
                    setCreateError(null);
                    void threads
                      .newAfterRecoveryFailure(thread.key)
                      .then((draft) => onOpened(draft.key))
                      .catch(() =>
                        setCreateError(STRINGS.repair.newDraftFailed),
                      )
                      .finally(() => setCreating(false));
                  }}
                >
                  {creating
                    ? STRINGS.repair.newDraftBusy
                    : STRINGS.repair.newDraft}
                </button>
                {createError && <span role="alert">{createError}</span>}
              </div>
            )}
            {!thread.running && hasActiveTools(thread) && (
              <div className="banner" role="status">
                {lastCompletion?.status === "stopped"
                  ? STRINGS.thread.toolsAfterStop
                  : STRINGS.thread.toolsAfterReply}
              </div>
            )}
            {empty && !thread.openError && (
              <div className="who">{STRINGS.thread.draftHint}</div>
            )}
            {blocks.map((block) => {
              const first = block[0]!;
              if (first.kind === "tool") {
                return (
                  <details key={first.id} className="workspace-steps">
                    <summary>
                      <BookOpenIcon size={15} aria-hidden="true" />
                      <span>{T.process}</span>
                      <small>{T.stepCount(block.length)}</small>
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          toolActivityState(thread, item.call) === "active" &&
                          item.call.status === "in_progress",
                      ) && (
                        <span className="workspace-step-running">
                          {W.stepsRunning}
                        </span>
                      )}
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          toolActivityState(thread, item.call) === "active" &&
                          item.call.status === "pending",
                      ) && (
                        <span className="workspace-step-running">
                          {W.stepsPending}
                        </span>
                      )}
                      {block.some(
                        (item) =>
                          item.kind === "tool" &&
                          toolActivityState(thread, item.call) === "unknown",
                      ) && <span>{STRINGS.thread.toolResultUnknown}</span>}
                      {block.some(
                        (item) =>
                          item.kind === "tool" && item.call.status === "failed",
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
                              activity={toolActivityState(thread, item.call)}
                              onOpenArtifacts={
                                paneCards({ ...thread, items: [item] }).some(
                                  (card) =>
                                    card.kind === "diff" ||
                                    card.output.length > 0,
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
                  </details>
                );
              }
              switch (first.kind) {
                case "user":
                  return (
                    <div key={first.id} className="workspace-message-user">
                      <div className="who">
                        {STRINGS.thread.you} · {timeLabel(first.time)}
                        {first.text && <MessageCopyButton text={first.text} />}
                      </div>
                      <div className="msg-user">{first.text}</div>
                      <MessageAttachments attachments={first.attachments} />
                    </div>
                  );
                case "agent":
                  return (
                    <div key={first.id} className="workspace-message-agent">
                      <div className="who">
                        {agent && <AgentLogo card={agent} />}
                        {agent?.name ?? thread.agentId} ·{" "}
                        {timeLabel(first.time)}
                        {first.text && <MessageCopyButton text={first.text} />}
                      </div>
                      <div className="assistant">
                        <MessageContent
                          source={first}
                          text={first.text}
                          attachments={first.attachments}
                        />
                        {thread.running && first.streaming && (
                          <span className="caret" />
                        )}
                      </div>
                    </div>
                  );
                case "thought":
                  return (
                    <details
                      key={first.id}
                      className={`thinking-block${thread.running && first.streaming ? " streaming" : ""}`}
                    >
                      <summary>{STRINGS.thread.thinking}</summary>
                      <p>{first.text}</p>
                    </details>
                  );
                case "plan":
                  return <PlanBlock key={first.id} entries={first.entries} />;
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
                    <RawBlock
                      key={first.id}
                      update={first.update}
                      label={
                        first.label === "notification"
                          ? STRINGS.thread.rawNotification
                          : undefined
                      }
                    />
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
            <div ref={requestsRef} className="workspace-requests">
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
                      submitting={permission.status === "submitting"}
                      onUndo={() =>
                        threads.undoPermissionDecision(
                          thread.key,
                          permission.requestId,
                        )
                      }
                    />
                  ) : (
                    <ApprovalCard
                      disabled={thread.stopping}
                      title={permission.title}
                      kind={permission.kind}
                      locations={permission.locations}
                      rawInput={permission.toolCallSnapshot?.rawInput}
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
                  key={request.requestId}
                  request={request}
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
            <span>{W.requestPending(pendingCount)}</span>
            <button
              type="button"
              onClick={() =>
                requestsRef.current?.scrollIntoView({
                  block: "end",
                  behavior: "smooth",
                })
              }
            >
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
          <FileFeedbackDrafts key={thread.key} threadKey={thread.key} />
          <Composer
            thread={thread}
            active={active}
            editableWhenDisabled
            autofocus={active}
            draftKey={`session:${thread.key}`}
            imageEnabled={imageOk}
            embedContext={embedContext}
            onGoSettings={onGoSettings}
            disabled={draftReadRequired}
            note={draftReadRequired ? C.readRequired : undefined}
            prepareAction={draftReadRequired ? onGoSettings : undefined}
            onSend={
              thread.identity === "draft"
                ? async (blocks) => {
                    // Composer calls after attachments and draft persistence settle.
                    if (
                      thread.identity === "draft" &&
                      pendingPreparationRead(thread)
                    )
                      throw new Error(C.readRequired);
                    await threads.send(thread.key, blocks);
                  }
                : undefined
            }
            controls={
              active ? (
                <>
                  <WorkspacePopover
                    title={W.modelChoice}
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
                    {!draftReadRequired &&
                      thread.identity === "draft" &&
                      !thread.resumed &&
                      modelOption && (
                        <ModelPicker
                          option={modelOption}
                          disabled={thread.configuring || thread.running}
                          onPick={(value) => {
                            if (pendingPreparationRead(thread)) return;
                            void threads
                              .setConfig(thread.key, modelOption.id, value)
                              .catch(() => undefined);
                          }}
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
                  {!draftReadRequired && <ReasoningControl thread={thread} />}
                  {!draftReadRequired && <PermissionControl thread={thread} />}
                </>
              ) : null
            }
          />
        </div>
      </div>
      {thread.artifactPaneOpen && (
        <ArtifactPane
          thread={thread}
          active={active}
          returnFocusRef={artifactReturnFocus}
        />
      )}
    </div>
  );
}
