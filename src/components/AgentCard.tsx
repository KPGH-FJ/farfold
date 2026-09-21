import type { ReactNode } from "react";
import {
  agentIdentity,
  agentStatusLabel,
  type AgentBusy,
  type AgentCardModel,
} from "../runtime/agents";
import { STRINGS } from "../runtime/strings";

export interface AgentCardProps {
  card: AgentCardModel;
  busy: AgentBusy | null;
  error: string | null;
  workOn: boolean;
  workDisabled?: boolean;
  confirmRemove: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onToggleWork: (on: boolean) => void;
  /** Login block shown between actions and capability toggles. */
  authSection?: ReactNode;
}

function CapRow({
  name,
  desc,
  on,
  disabled,
  dim,
  onToggle,
}: {
  name: string;
  desc: string;
  on: boolean;
  disabled?: boolean;
  dim?: boolean;
  onToggle?: (on: boolean) => void;
}) {
  return (
    <div className={`cap ${dim ? "dim" : ""}`}>
      <div>
        <div className="cn">{name}</div>
        <div className="cd">{desc}</div>
      </div>
      <button
        type="button"
        className={`tog ${on ? "on" : ""}`}
        disabled={disabled}
        aria-pressed={on}
        onClick={() => onToggle?.(!on)}
      />
    </div>
  );
}

export function AgentCard({
  card,
  busy,
  error,
  workOn,
  workDisabled = false,
  confirmRemove,
  onConnect,
  onDisconnect,
  onRemove,
  onToggleWork,
  authSection,
}: AgentCardProps) {
  const identity = agentIdentity(card.id, card.name);
  const connected = card.status === "connected";
  const attached = connected || card.status === "installed";
  const working = busy !== null;

  const connectLabel =
    busy === "install"
      ? STRINGS.agents.installing
      : busy === "connect"
        ? STRINGS.agents.connecting
        : STRINGS.agents.connect;

  return (
    <div className="agent-card" data-agent={card.id}>
      <div className="ac-head">
        <span className={`id ${identity.cls}`}>{identity.letter}</span>
        <span className="ac-name">{card.name}</span>
        {card.version && <span className="ac-ver">v{card.version}</span>}
        <span className={`ac-state ${card.status}`}>
          {agentStatusLabel(card)}
        </span>
      </div>
      <div className="ac-desc">{card.description}</div>
      <div className="ac-facts">
        {card.discoveredPath && (
          <span className="ac-fact">
            {STRINGS.agents.discoveredAt(card.discoveredPath)}
          </span>
        )}
        {card.registryVersion && !connected && (
          <span className="ac-fact">
            {STRINGS.agents.registryVersion(card.registryVersion)}
          </span>
        )}
        {connected && (
          <span className="ac-fact">
            {STRINGS.agents.authMethods(card.authMethods.length)}
          </span>
        )}
        {card.source && (
          <span className="ac-fact">{STRINGS.agents.source[card.source]}</span>
        )}
      </div>
      {error && (
        <div className="ac-error" role="alert">
          {error}
        </div>
      )}
      <div className="ac-actions">
        {connected ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={working}
            onClick={onDisconnect}
          >
            {busy === "disconnect"
              ? STRINGS.agents.disconnecting
              : STRINGS.agents.disconnect}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={working}
            onClick={onConnect}
          >
            {connectLabel}
          </button>
        )}
        {card.custom && (
          <button
            type="button"
            className="btn btn-text"
            disabled={working}
            onClick={onRemove}
          >
            {confirmRemove
              ? STRINGS.agents.removeConfirm
              : STRINGS.agents.remove}
          </button>
        )}
      </div>
      {connected && authSection}
      {attached && (
        <div className="caps">
          <CapRow
            name={STRINGS.agents.caps.work.name}
            desc={STRINGS.agents.caps.work.desc}
            on={workOn}
            disabled={workDisabled}
            onToggle={(on) => {
              if (!workDisabled) onToggleWork(on);
            }}
          />
          <CapRow
            name={STRINGS.agents.caps.contribute.name}
            desc={`${STRINGS.agents.caps.contribute.desc} · ${STRINGS.agents.caps.comingSoon}`}
            on={false}
            disabled
            dim
          />
          <CapRow
            name={STRINGS.agents.caps.use.name}
            desc={`${STRINGS.agents.caps.use.desc} · ${STRINGS.agents.caps.comingSoon}`}
            on={false}
            disabled
            dim
          />
        </div>
      )}
    </div>
  );
}
