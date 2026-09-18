/**
 * 顶栏「Agent · 模型」切换器。
 * 已开会话：只读显示 Agent · 模型值（创建即确定，不可更改）。
 * 草稿会话（尚未发第一条消息）：模型下拉可选，写入 session_set_config。
 * 另导出 `ModelSelect` 与 `AgentPick` 供开始页复用。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import {
  configValueLabel,
  modelConfigOption,
  threads,
  type ConfigOptionView,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

/** 可被用来开会的 Agent：已注册或已连接；未接入的灰显。 */
export function usableAgents(cards: AgentCardModel[]): AgentCardModel[] {
  return cards.filter(
    (c) => c.status === "installed" || c.status === "connected" || c.custom,
  );
}

export function ModelSelect({
  option,
  disabled,
  onPick,
}: {
  option: ConfigOptionView | null;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  if (!option || option.type !== "select" || option.options.length === 0) {
    return <span className="sw-sel">{STRINGS.switcher.defaultModel}</span>;
  }
  const groups = [...new Set(option.options.map((o) => o.group ?? ""))];
  const current =
    typeof option.currentValue === "string" ? option.currentValue : "";
  return (
    <select
      disabled={disabled}
      value={current}
      onChange={(e) => onPick(e.target.value)}
    >
      {groups.map((group) =>
        group ? (
          <optgroup key={group} label={group}>
            {option.options
              .filter((o) => o.group === group)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name}
                </option>
              ))}
          </optgroup>
        ) : (
          option.options
            .filter((o) => !o.group)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.name}
              </option>
            ))
        ),
      )}
    </select>
  );
}

/** 开始页 Agent 选择行（F-start-empty .agent-pick）。 */
export function AgentPick({
  cards,
  picked,
  onPick,
  onGoSettings,
}: {
  cards: AgentCardModel[];
  picked: string | null;
  onPick: (id: string) => void;
  onGoSettings: () => void;
}) {
  const usable = usableAgents(cards);
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
            {card.name}
            {card.status === "connected" && (
              <span className="p-model">
                {STRINGS.agents.status.connected(card.version)}
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
            {card.name}
            <span className="p-model">{STRINGS.switcher.notConnected}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 顶栏切换器按钮 + 下拉面板。 */
export function AgentSwitcher({
  thread,
  cards,
  onGoSettings,
}: {
  thread: ThreadState;
  cards: AgentCardModel[];
  onGoSettings: () => void;
}) {
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
  const modelEditable = !thread.prompted && modelOption?.type === "select";

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
              <ModelSelect
                option={modelOption}
                onPick={(value) =>
                  void threads.setConfig(thread.key, modelOption!.id, value)
                }
              />
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
          {usableAgents(cards).map((card) => {
            const cIdent = agentIdentity(card.id, card.name);
            return (
              <div key={card.id} className="sw-row off" style={{ opacity: 1 }}>
                <span className={`id ${cIdent.cls}`}>{cIdent.letter}</span>
                {card.name}
                {card.id === thread.agentId ? (
                  <span className="note">
                    {STRINGS.switcher.currentSession}
                  </span>
                ) : (
                  <span className="note">{STRINGS.switcher.immutableNote}</span>
                )}
              </div>
            );
          })}
          {cards
            .filter((c) => !usableAgents(cards).includes(c))
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
                  <span className="note">{STRINGS.switcher.notConnected}</span>
                </div>
              );
            })}
        </div>
      )}
    </>
  );
}
