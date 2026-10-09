import React, { useRef } from "react";
import { Square } from "@phosphor-icons/react";
import { AgentIcon, Badge, Button } from "./ui";
import {
  EngineeringSteps,
  EngineeringResult,
} from "./ConversationEngineering.jsx";
import WorkspaceConversation, {
  WorkspaceFollowup,
} from "./WorkspaceConversation.jsx";
import {
  scenarioFor,
  previewKindFor,
  previewIntroFor,
  PreviewResponse,
  ScenarioSteps,
  ScenarioResult,
} from "./ConversationScenarios.jsx";
import {
  INITIAL_APPROVALS,
  normalMessages,
  isPresetTask,
  hasPresetResults,
  SentAttachments,
  SimulationResult,
  Approval,
} from "./ConversationParts.jsx";
import { replyAt, readableTranscript } from "./conversation-state.js";
import ConversationMessageActions from "./ConversationMessageActions.jsx";

function Requests({
  task,
  stopping,
  onTaskChange,
  onDecision,
  onSubmitAnswer,
  onCancelQuestion,
  onCheckQuestion,
}) {
  const scenario = scenarioFor(task);
  const question = task.answerDraft || { choice: "existing", note: "" };
  const answerLocked = stopping || Boolean(task.questionSubmission);
  const approvalAnswers = task.approvalAnswers || {};
  return (
    <>
      {task.status === "approval" && (
        <div className="conv-interactions">
          <div className="conv-section-caption">
            {task.stopPhase === "waiting"
              ? "正在等待停止确认，原审批保留且暂不能操作"
              : task.stopPhase === "unknown"
                ? "停止结果未确认，请先检查结果；原审批仍保留"
                : `有 ${INITIAL_APPROVALS.filter((request) => !approvalAnswers[request.id]).length} 项操作需要你决定`}
          </div>
          {INITIAL_APPROVALS.map((request) => (
            <Approval
              key={`${task.id}-${request.id}`}
              request={request}
              answer={approvalAnswers[request.id]}
              onDecision={onDecision}
              disabled={stopping}
              stopPhase={task.stopPhase}
            />
          ))}
        </div>
      )}
      {task.status === "question" && (
        <section className="conv-approval">
          <div className="conv-card-label">
            <Badge tone="amber">
              {task.stopPhase === "waiting"
                ? "等待停止确认"
                : task.stopPhase === "unknown"
                  ? "停止结果未确认"
                  : task.questionSubmission?.phase === "unknown"
                    ? "回答提交结果未确认"
                    : "需要回答"}
            </Badge>
            <span>1 个问题</span>
          </div>
          <h3>{scenario?.question || "这次需要保留现有视觉风格吗？"}</h3>
          <p>
            {scenario?.questionNote || "两种方式都可以，我会根据你的选择继续。"}
          </p>
          <div className="conv-question-options">
            {(
              scenario?.options || [
                {
                  id: "existing",
                  title: "保留现有风格",
                  detail: "只完善层级、操作和反馈。",
                },
                {
                  id: "explore",
                  title: "探索新的视觉方向",
                  detail: "先给出设计方案，确认后再调整。",
                },
              ]
            ).map((x) => (
              <label
                key={x.id}
                className={question.choice === x.id ? "selected" : ""}
              >
                <input
                  type="radio"
                  disabled={answerLocked}
                  name={`style-${task.id}`}
                  checked={question.choice === x.id}
                  onChange={() =>
                    onTaskChange({
                      answerDraft: { ...question, choice: x.id },
                    })
                  }
                />
                <span>
                  <strong>{x.title}</strong>
                  <small>{x.detail}</small>
                </span>
              </label>
            ))}
          </div>
          <label className="conv-question-note">
            补充说明 <span>可选</span>
            <textarea
              value={question.note}
              disabled={answerLocked}
              onChange={(e) =>
                onTaskChange({
                  answerDraft: {
                    ...question,
                    note: e.target.value,
                  },
                })
              }
              placeholder={
                scenario?.notePlaceholder || "还有哪些细节需要保留？"
              }
            />
          </label>
          <div className="conv-card-actions">
            <Button primary disabled={answerLocked} onClick={onSubmitAnswer}>
              提交回答
            </Button>
            <Button
              kind="text"
              disabled={answerLocked}
              onClick={onCancelQuestion}
            >
              取消这次询问
            </Button>
          </div>
          {task.questionSubmission?.phase === "unknown" && (
            <div className="cr-action-state" role="status">
              <div>
                <strong>回答提交结果未确认</strong>
                <p>你选择的答案和补充说明已保留。先检查结果，避免重复提交。</p>
              </div>
              <Button onClick={onCheckQuestion}>
                检查回答提交结果（演示）
              </Button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Reply({
  reply: task,
  current,
  stopping,
  workspace,
  workspacePanel,
  onSelectWorkspace,
  onFeedback,
  openPane,
  copy,
  onNewFromMessage,
  children,
}) {
  const replyElement = useRef(null);
  const scenario = scenarioFor(task);
  const interactive =
    task.id.startsWith("new-") || task.resultMode === "simulated";
  const simulated = interactive || (!workspace && !isPresetTask(task));
  const kind =
    task.previewKind ||
    previewKindFor(task.previewPrompt || task.prompt, task.demoKind);
  const pending = ["approval", "question"].includes(task.status);
  const blocked = ["recovery", "unknown"].includes(task.status);
  const running = task.status === "running";
  const decisionResult = task.resultMode === "decision";
  const preset =
    !decisionResult &&
    !scenario &&
    !workspace &&
    !simulated &&
    hasPresetResults(task);
  const engineering =
    !scenario &&
    !workspace &&
    !interactive &&
    isPresetTask(task) &&
    !["simulated", "plan", "decision"].includes(task.resultMode);
  const open = (tab, file) => openPane(tab, file, task);
  return (
    <div ref={replyElement} style={{ display: "contents" }}>
      <div className="conv-agent-message" data-reply-round={task.round}>
        <div className="conv-message-meta">
          <AgentIcon name={task.agent} size={21} />
          <strong>{task.agent}</strong>
          <ConversationMessageActions
            task={task}
            message={{ role: "assistant" }}
            resolveMessage={() => ({
              role: "assistant",
              text: readableTranscript(replyElement.current),
            })}
            copy={copy}
            onNewFromMessage={onNewFromMessage}
          />
        </div>
        <p>
          {decisionResult
            ? task.decisionOutcome === "declined"
              ? "已收到你拒绝执行的决定。"
              : "已收到取消回答的决定。"
            : workspace
              ? task.round === 0
                ? workspace.summary
                : "这条补充已收到，可以接着对照现有内容讨论。"
              : interactive || !isPresetTask(task)
                ? previewIntroFor(kind)
                : scenario
                  ? scenario.intro
                  : engineering
                    ? "我先检查项目卡片和现有样式，再补充键盘操作与测试。会保持当前的视觉语言。"
                    : task.resultMode === "plan"
                      ? "已记录你先看方案的选择，等待方向确认后再决定下一步。"
                      : "已收到演示消息。这里仅模拟对话、排队与完成反馈，不会执行实际项目操作。"}
        </p>
        {!decisionResult && workspace && task.round === 0 && (
          <WorkspaceConversation
            kind={task.workspaceKind}
            data={workspace}
            panel={workspacePanel}
            onSelect={onSelectWorkspace}
            onFeedback={onFeedback}
          />
        )}
        {!decisionResult && scenario && !interactive && (
          <ScenarioSteps scenario={scenario} status={task.status} />
        )}
        {engineering && (
          <EngineeringSteps
            pending={pending}
            resultsAvailable={preset}
            blocked={blocked}
            stepWait={
              pending
                ? "等待你的决定"
                : blocked
                  ? "结果待确认"
                  : task.status === "stopped"
                    ? "已停止"
                    : "等待执行"
            }
            isRunning={running}
            openPane={open}
          />
        )}
      </div>
      {children}
      {preset && (
        <EngineeringResult simulated={false} openPane={open} copy={copy} />
      )}
      {!decisionResult &&
        task.status === "done" &&
        scenario &&
        !interactive && (
          <ScenarioResult
            scenario={scenario}
            task={task}
            openPane={open}
            copy={copy}
          />
        )}
      {!decisionResult &&
        task.status === "done" &&
        simulated &&
        (workspace ? (
          <WorkspaceFollowup kind={task.workspaceKind} />
        ) : (
          <PreviewResponse kind={kind} attachments={task.replyAttachments} />
        ))}
      {decisionResult && task.status === "done" && (
        <div className="conv-stop-result">
          <div>
            <strong>Agent 已结束本次请求（模拟）</strong>
            <p>
              {task.decisionOutcome === "declined"
                ? "未执行被拒绝的操作。"
                : "没有提交你的未完成回答。"}
              草稿与待发消息保留，可以另行发送要求。
            </p>
          </div>
        </div>
      )}
      {task.status === "done" && !scenario && task.resultMode === "plan" && (
        <SimulationResult plan note={task.answerDraft?.note} />
      )}
      {task.status === "stopped" && (
        <div className="conv-stop-result">
          <Square size={15} weight="fill" />
          <div>
            <strong>已停止</strong>
            <p>
              {current
                ? task.queue?.length
                  ? "已完成的内容仍在这里。待发消息保留，点击“继续发送”后才会继续。"
                  : "已完成的内容仍在这里。你可以输入新的要求并发送，继续这条对话。"
                : "这一轮已停止，后续消息接在下方。"}
            </p>
          </div>
        </div>
      )}
      {current && running && (
        <div className="conv-running-line">
          <span className="conv-pulse" />
          {stopping
            ? "已请求停止，正在等待 Agent 确认…"
            : simulated
              ? "正在演示消息处理…"
              : "正在完成这轮工作…"}
          <span>你可以切换到其他对话</span>
        </div>
      )}
    </div>
  );
}

export default function ConversationTranscript({
  task,
  stopping,
  workspace,
  workspacePanel,
  onSelectWorkspace,
  onFeedback,
  openPane,
  copy,
  onTaskChange,
  onDecision,
  onSubmitAnswer,
  onCancelQuestion,
  onCheckQuestion,
  onNewFromMessage,
}) {
  const messages = [
    {
      text: task.prompt ?? scenarioFor(task)?.prompt ?? task.title,
      attachments: task.sentAttachments,
    },
    ...normalMessages(task.extraMessages),
  ];
  const history = task.imported ? (
    <section aria-label="带入的示例历史" className="conv-imported-history">
      <p className="conv-imported-caption">
        来自 {task.agent} · 示例历史 · 未读取真实对话
      </p>
      {(task.importedMessages || []).map((message, index) => (
        <div
          className={
            message.role === "user" ? "conv-user-message" : "conv-agent-message"
          }
          key={index}
        >
          <div className="conv-message-meta">
            {message.role !== "user" && (
              <AgentIcon name={task.agent} size={21} />
            )}
            <strong>{message.role === "user" ? "你" : task.agent}</strong>
            <ConversationMessageActions
              task={task}
              message={message}
              copy={copy}
              onTaskChange={onTaskChange}
              onNewFromMessage={onNewFromMessage}
            />
          </div>
          <p style={{ whiteSpace: "pre-wrap" }}>{message.text}</p>
        </div>
      ))}
    </section>
  ) : null;
  return (
    <>
      {history}
      {messages.map((message, round) => {
        if (task.imported && round === 0) return null;
        const reply = replyAt(task, round);
        const current = round === messages.length - 1;
        return (
          <React.Fragment key={round}>
            <div className="conv-user-message">
              <div className="conv-message-meta">
                <strong>你</strong>
                <ConversationMessageActions
                  task={task}
                  message={message}
                  copy={copy}
                  onTaskChange={onTaskChange}
                  onNewFromMessage={onNewFromMessage}
                />
              </div>
              {message.text && <p>{message.text}</p>}
              <SentAttachments attachments={message.attachments} />
            </div>
            {reply && (
              <Reply
                reply={reply}
                current={current}
                stopping={stopping}
                workspace={workspace}
                workspacePanel={workspacePanel}
                onSelectWorkspace={onSelectWorkspace}
                onFeedback={onFeedback}
                openPane={openPane}
                copy={copy}
                onNewFromMessage={onNewFromMessage}
              >
                {current && (
                  <Requests
                    task={task}
                    stopping={stopping}
                    onTaskChange={onTaskChange}
                    onDecision={onDecision}
                    onSubmitAnswer={onSubmitAnswer}
                    onCancelQuestion={onCancelQuestion}
                    onCheckQuestion={onCheckQuestion}
                  />
                )}
              </Reply>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
