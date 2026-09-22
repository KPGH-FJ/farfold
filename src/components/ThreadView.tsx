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
  const reasonLabel =
    item.stopReason &&
    !(item.status !== "done" && item.stopReason === "end_turn")
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
  decision: { label: string; allow: boolean; undoable: boolean };
  onUndo: () => void;
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
      <span className={decision.allow ? "ok" : "no"}>
        {decision.allow ? "✓ " : "✗ "}
        {decision.label}
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
  agents,
  onGoSettings,
  onOpened,
}: {
  thread: ThreadState;
  agents: AgentCardModel[];
  onGoSettings: () => void;
  onOpened: (key: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const agent = useMemo(
    () => agents.find((a) => a.id === thread.agentId) ?? null,
    [agents, thread.agentId],
  );
  const ident = agent ? agentIdentity(agent.id, agent.name) : null;
  const imageOk = promptCapabilities(agent).image;
  const embedContext = promptCapabilities(agent).embeddedContext;

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
  }, [thread.items.length, streamTail, thread.pendingPermissions]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
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
    const permission =
      thread.pendingPermissions.find(
        (p) => p.requestId === focusedPermission && !p.decision,
      ) ?? thread.pendingPermissions.find((p) => !p.decision);
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
      decidePermissionOption(permission.requestId, option);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread.pendingPermissions, thread.key, focusedPermission]);

  const permissions = thread.pendingPermissions;
  const blocks = itemBlocks(thread.items);
  const empty =
    thread.items.length === 0 &&
    permissions.length === 0 &&
    !thread.connectionLost;

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
            {thread.modelDrift && (
              <div className="banner" role="status">
                <span>{STRINGS.repair.newDraftHint}</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={creating}
                  onClick={() => {
                    if (creating) return;
                    setCreating(true);
                    setCreateError(null);
                    void threads
                      .newAfterModelDrift(thread.key)
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
            {thread.stopUnconfirmed && (
              <div className="banner" role="status">
                <span className="b-tag">{STRINGS.thread.needYou}</span>
                <span>{STRINGS.repair.stopUnconfirmed}</span>
                {thread.running && !thread.connectionLost && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void threads.cancel(thread.key)}
                  >
                    {STRINGS.repair.retryStop}
                  </button>
                )}
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
                          <ToolStep key={item.id} call={item.call} />
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
                    onUndo={() =>
                      threads.undoPermissionDecision(
                        thread.key,
                        permission.requestId,
                      )
                    }
                  />
                ) : (
                  <ApprovalCard
                    title={permission.title}
                    kind={permission.kind}
                    locations={permission.locations}
                    options={permission.options}
                    onPick={(option) =>
                      decidePermissionOption(permission.requestId, option)
                    }
                  />
                )}
              </div>
            ))}
            {thread.pendingElicitation && <ElicitationCard thread={thread} />}
          </div>
        </div>
        <div className="composer-wrap">
          <Composer
            thread={thread}
            imageEnabled={imageOk}
            embedContext={embedContext}
            onGoSettings={onGoSettings}
          />
        </div>
      </div>
      {thread.artifactPaneOpen && <ArtifactPane thread={thread} />}
    </div>
  );
}
