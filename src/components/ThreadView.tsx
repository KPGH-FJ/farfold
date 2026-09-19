/**
 * 会话正文：消息流 + 步骤流 + 审批卡 + 结束行 + 连接横幅 + 消息栏。
 * 渲染数据来自 `runtime/sessions.ts` 的归一化 ThreadState。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity, promptCapabilities } from "../runtime/agents";
import {
  threads,
  type PermissionOption,
  type ThreadItem,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { ArtifactPane } from "./ArtifactPane";
import { Composer } from "./Composer";
import { ElicitationCard } from "./ElicitationCard";
import { MessageContent } from "./MessageContent";
import {
  ApprovalCard,
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
  onOpenArtifacts,
}: {
  item: Extract<ThreadItem, { kind: "settled" }>;
  onOpenArtifacts: () => void;
}) {
  const label =
    item.status === "done"
      ? STRINGS.thread.done
      : item.status === "stopped"
        ? STRINGS.thread.stopped
        : item.status === "unknown"
          ? STRINGS.thread.unknown
          : STRINGS.thread.failed;
  const cls =
    item.status === "done" ? "ok" : item.status === "unknown" ? "warn" : "no";
  const reasonLabel = item.stopReason
    ? STRINGS.thread.stopReasonLabel(item.stopReason)
    : null;
  return (
    <>
      <div className="settled">
        <span className={cls}>
          {item.status === "done"
            ? "✓ "
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
      {item.artifactCount > 0 && (
        <button
          type="button"
          className="round-sum round-artifacts"
          onClick={onOpenArtifacts}
        >
          {STRINGS.thread.roundArtifacts(item.artifactCount)}
        </button>
      )}
    </>
  );
}

function DecisionLine({
  decision,
  onUndo,
}: {
  decision: { label: string; allow: boolean };
  onUndo: () => void;
}) {
  const [left, setLeft] = useState(5);
  useEffect(() => {
    const timer = window.setInterval(
      () => setLeft((v) => Math.max(0, v - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="settled">
      <span className={decision.allow ? "ok" : "no"}>
        {decision.allow ? "✓ " : "✗ "}
        {decision.label}
      </span>
      <button type="button" className="undo" onClick={onUndo}>
        {STRINGS.thread.undo} {STRINGS.thread.secondsLeft(left)}
      </button>
    </div>
  );
}

/* ── 主组件 ── */

export function ThreadView({
  thread,
  agents,
  onGoSettings,
}: {
  thread: ThreadState;
  agents: AgentCardModel[];
  onGoSettings: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const agent = useMemo(
    () => agents.find((a) => a.id === thread.agentId) ?? null,
    [agents, thread.agentId],
  );
  const ident = agent ? agentIdentity(agent.id, agent.name) : null;
  const imageOk = promptCapabilities(agent).image;

  // 底部跟滚：新条目/流式内容增长时保持在底部（用户上翻则停）。
  const follow = useRef(true);
  const lastItem = thread.items[thread.items.length - 1];
  const streamTail =
    lastItem && "text" in lastItem
      ? lastItem.text.length
      : lastItem?.kind === "tool"
        ? lastItem.call.status
        : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [thread.items.length, streamTail, thread.pendingPermission]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // 审批快捷键（输入框未聚焦时）
  useEffect(() => {
    const permission = thread.pendingPermission;
    if (!permission || permission.decision) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      const pick = (kinds: string[]) =>
        permission.options.find((o) => kinds.includes(o.kind)) ??
        permission.options.find((o) => o.kind.startsWith("allow")) ??
        null;
      let option: PermissionOption | null = null;
      if (e.metaKey && e.key === "Enter") {
        option = pick(["allow_always"]);
      } else if (e.key === "Enter") {
        option = pick(["allow_once"]);
      } else if (e.key === "Backspace") {
        option =
          permission.options.find((o) => o.kind.startsWith("reject")) ?? null;
      }
      if (option) {
        e.preventDefault();
        decide(option);
      }
    };
    const decide = (option: PermissionOption) => {
      const label =
        option.kind === "allow_once"
          ? STRINGS.thread.approved(option.name)
          : option.kind === "allow_always"
            ? STRINGS.thread.approvedRemember(option.name)
            : STRINGS.thread.rejected;
      threads.decidePermission(
        thread.key,
        option.optionId,
        label,
        option.kind.startsWith("allow"),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread.pendingPermission, thread.key]);

  const permission = thread.pendingPermission;
  const blocks = itemBlocks(thread.items);
  const empty =
    thread.items.length === 0 && !permission && !thread.connectionLost;

  const openArtifacts = () => void threads.openArtifactPane(thread.key);

  return (
    <div className="thread-body">
      <div className="thread-main">
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
            {thread.connectionLost && (
              <div className="banner">
                <span className="b-tag">{STRINGS.thread.needYou}</span>
                <span>{STRINGS.thread.connectionLost}</span>
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
            {empty && !thread.openError && (
              <div className="who">{STRINGS.thread.draftHint}</div>
            )}
            {blocks.map((block) => {
              const first = block[0]!;
              if (first.kind === "tool") {
                return (
                  <div key={first.id} className="steps">
                    {block.map(
                      (item) =>
                        item.kind === "tool" && (
                          <ToolStep
                            key={item.id}
                            call={item.call}
                            terminalTails={thread.terminalTails}
                            onOpenArtifacts={openArtifacts}
                          />
                        ),
                    )}
                  </div>
                );
              }
              switch (first.kind) {
                case "user":
                  return (
                    <div key={first.id}>
                      <div className="who">
                        {STRINGS.thread.you} · {timeLabel(first.time)}
                      </div>
                      <div className="msg-user">{first.text}</div>
                      {first.attachments.length > 0 && (
                        <div className="m-chips">
                          {first.attachments.map((a, i) => (
                            <span key={i} className="chip">
                              {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                case "agent":
                  return (
                    <div key={first.id}>
                      <div className="who">
                        {ident && (
                          <span className={`id ${ident.cls}`}>
                            {ident.letter}
                          </span>
                        )}
                        {agent?.name ?? thread.agentId} ·{" "}
                        {timeLabel(first.time)}
                      </div>
                      <div className="assistant">
                        <MessageContent text={first.text} />
                        {first.streaming && <span className="caret" />}
                      </div>
                    </div>
                  );
                case "thought":
                  return (
                    <details
                      key={first.id}
                      className={`thinking-block${first.streaming ? " streaming" : ""}`}
                    >
                      <summary>{STRINGS.thread.thinking}</summary>
                      <p>{first.text}</p>
                    </details>
                  );
                case "plan":
                  return <PlanBlock key={first.id} entries={first.entries} />;
                case "settled":
                  return (
                    <SettledLine
                      key={first.id}
                      item={first}
                      onOpenArtifacts={openArtifacts}
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
                default:
                  return null;
              }
            })}
            {permission &&
              (permission.decision ? (
                <DecisionLine
                  decision={permission.decision}
                  onUndo={() => threads.undoPermissionDecision(thread.key)}
                />
              ) : (
                <ApprovalCard
                  title={permission.title}
                  kind={permission.kind}
                  locations={permission.locations}
                  options={permission.options}
                  onPick={(option) => {
                    const label =
                      option.kind === "allow_once"
                        ? STRINGS.thread.approved(option.name)
                        : option.kind === "allow_always"
                          ? STRINGS.thread.approvedRemember(option.name)
                          : STRINGS.thread.rejected;
                    threads.decidePermission(
                      thread.key,
                      option.optionId,
                      label,
                      option.kind.startsWith("allow"),
                    );
                  }}
                />
              ))}
            {thread.pendingElicitation && <ElicitationCard thread={thread} />}
          </div>
        </div>
        <div className="composer-wrap">
          <Composer
            thread={thread}
            imageEnabled={imageOk}
            onGoSettings={onGoSettings}
          />
        </div>
      </div>
      {thread.artifactPaneOpen && <ArtifactPane thread={thread} />}
    </div>
  );
}
