/**
 * 顶栏「Agent · 模型」切换器。
 * 已开会话：只读显示 Agent · 模型值（创建即确定，不可更改）。
 * 草稿会话（尚未发第一条消息）：模型选择器可选，写入 session_set_config。
 * 另导出 `AgentPick` 供开始页复用；模型选择用 `ModelPicker`。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import { ModelPicker } from "./ModelPicker";
import {
  configValueLabel,
  modelConfigOption,
  threads,
  useThreadsSnapshot,
  type IndexRow,
  type SidebarRow,
  type ThreadState,
} from "../runtime/sessions";
import { useWorkPolicy } from "../runtime/work_policy";
import { STRINGS } from "../runtime/strings";

/** 可被用来开会的 Agent：已注册或已连接；未接入的灰显。 */
export function usableAgents(
  cards: AgentCardModel[],
  enabled: (id: string) => boolean = () => true,
): AgentCardModel[] {
  return cards.filter(
    (c) =>
      enabled(c.id) &&
      (c.status === "installed" || c.status === "connected" || c.custom),
  );
}

/** 开始页 Agent 选择行（F-start-empty .agent-pick）。 */
export function AgentPick({
  cards,
  enabled = () => true,
  picked,
  onPick,
  onGoSettings,
}: {
  cards: AgentCardModel[];
  enabled?: (id: string) => boolean;
  picked: string | null;
  onPick: (id: string) => void;
  onGoSettings: () => void;
}) {
  const usable = usableAgents(cards, enabled);
  const others = cards.filter((c) => !usable.includes(c));
  return (
    <div className="agent-pick">
      {usable.map((card) => {
        const ident = agentIdentity(card.id, card.name);
        return (
          <button
            key={card.id}
            type="button"
            className={`pick${picked === card.id ? " on" : ""}`}
            onClick={() => onPick(card.id)}
          >
            <span className={`id ${ident.cls}`}>{ident.letter}</span>
            <span className="p-name">{card.name}</span>
            {card.status === "connected" && (
              <span className="p-model">
                <i className="p-dot" />
              </span>
            )}
          </button>
        );
      })}
      {others.map((card) => {
        const ident = agentIdentity(card.id, card.name);
        return (
          <button
            key={card.id}
            type="button"
            className="pick off"
            onClick={onGoSettings}
          >
            <span className={`id ${ident.cls}`}>{ident.letter}</span>
            <span className="p-name">{card.name}</span>
            <span className="p-model">
              {!enabled(card.id)
                ? STRINGS.repair.workOff
                : STRINGS.switcher.notConnected}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 顶栏切换器按钮 + 下拉面板（F 稿：当前会话 / 新会话·选择 Agent / 切换会话）。 */
export function AgentSwitcher({
  thread,
  cards,
  onGoSettings,
  onNewWithAgent,
  onSelectRow,
}: {
  thread: ThreadState;
  cards: AgentCardModel[];
  onGoSettings: () => void;
  onNewWithAgent: (agentId: string) => void;
  onSelectRow: (row: IndexRow | SidebarRow) => void;
}) {
  const work = useWorkPolicy(thread.cwd);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const agent = useMemo(
    () => cards.find((c) => c.id === thread.agentId) ?? null,
    [cards, thread.agentId],
  );
  const ident = agent ? agentIdentity(agent.id, agent.name) : null;
  const modelOption = modelConfigOption(thread.configOptions);
  const modelLabel = configValueLabel(modelOption);
  /** 草稿（尚未发第一条消息）里模型可选；创建后只读。 */
  const modelEditable =
    thread.identity === "draft" &&
    !thread.submitting &&
    !thread.configuring &&
    modelOption?.type === "select";

  // 「切换会话」节：非归档索引行按 需要你>在跑>最近 排序。
  const snapshot = useThreadsSnapshot();
  const sessionRows = useMemo(() => {
    const rank = (row: IndexRow) => {
      const live = snapshot.threads.get(row.id);
      if (live && threads.needsAttention(live)) return 0;
      if (live?.running) return 1;
      return 2;
    };
    return snapshot.index
      .filter((row) => !row.archived && row.id !== thread.key)
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
      .slice(0, 12);
  }, [snapshot.index, snapshot.threads, thread.key]);

  return (
    <>
      <button
        type="button"
        className="switcher"
        onClick={() => setOpen((v) => !v)}
      >
        {ident && <span className={`id ${ident.cls}`}>{ident.letter}</span>}
        {agent?.name ?? thread.agentId}
        {modelLabel && (
          <>
            <span className="model-sep">·</span>
            {modelLabel}
          </>
        )}
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="sw-panel" ref={panelRef}>
          <div className="sw-label">{STRINGS.switcher.currentSession}</div>
          <div className="sw-row" style={{ cursor: "default" }}>
            {ident && <span className={`id ${ident.cls}`}>{ident.letter}</span>}
            {agent?.name ?? thread.agentId}
            {modelEditable ? (
              <div className="sw-model">
                <ModelPicker
                  option={modelOption}
                  onPick={(value) =>
                    void threads
                      .setConfig(thread.key, modelOption!.id, value)
                      .catch(() => undefined)
                  }
                />
              </div>
            ) : (
              <span className="sw-sel">
                {modelLabel || STRINGS.switcher.defaultModel}
              </span>
            )}
          </div>
          <div className="sw-immutable">
            {modelEditable
              ? STRINGS.switcher.modelForNew
              : STRINGS.switcher.immutableNote}
          </div>
          <div className="sw-div" />
          <div className="sw-label">{STRINGS.switcher.newSection}</div>
          {usableAgents(cards, work.enabled).map((card) => {
            const cIdent = agentIdentity(card.id, card.name);
            const isCurrent = card.id === thread.agentId;
            return (
              <div
                key={card.id}
                className={`sw-row${isCurrent ? " off" : ""}`}
                onClick={() => {
                  if (isCurrent) return;
                  setOpen(false);
                  onNewWithAgent(card.id);
                }}
              >
                <span className={`id ${cIdent.cls}`}>{cIdent.letter}</span>
                {card.name}
                <span className="note">
                  {isCurrent
                    ? STRINGS.switcher.currentSession
                    : STRINGS.switcher.newWithAgent}
                </span>
              </div>
            );
          })}
          {cards
            .filter((c) => !usableAgents(cards, work.enabled).includes(c))
            .map((card) => {
              const cIdent = agentIdentity(card.id, card.name);
              return (
                <div
                  key={card.id}
                  className="sw-row off"
                  onClick={onGoSettings}
                >
                  <span className={`id ${cIdent.cls}`}>{cIdent.letter}</span>
                  {card.name}
                  <span className="note">
                    {!work.enabled(card.id)
                      ? STRINGS.repair.workOff
                      : STRINGS.switcher.notConnected}
                  </span>
                </div>
              );
            })}
          {sessionRows.length > 0 && (
            <>
              <div className="sw-div" />
              <div className="sw-label">{STRINGS.switcher.sessionSection}</div>
              {sessionRows.map((row) => {
                const live = snapshot.threads.get(row.id);
                const status = live
                  ? threads.needsAttention(live)
                    ? "need"
                    : live.running
                      ? "run"
                      : null
                  : null;
                const sIdent = agentIdentity(row.agentId, row.agentId);
                return (
                  <div
                    key={row.id}
                    className="sw-row"
                    onClick={() => {
                      setOpen(false);
                      onSelectRow(row);
                    }}
                  >
                    <span className={`id ${sIdent.cls}`}>{sIdent.letter}</span>
                    <span className="sw-title">
                      {row.title || STRINGS.sessions.untitled}
                    </span>
                    {status && (
                      <span className={`st ${status}`}>
                        {status === "need"
                          ? STRINGS.sessions.needYou
                          : STRINGS.sessions.running}
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </>
  );
}
