import type { ReactNode } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  agentIdentity,
  agentStatusLabel,
  type AgentBusy,
  type AgentCardModel,
  type InstallProgress,
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
  installProgress?: InstallProgress;
  onInstall?: () => void;
  onCancelInstall?: () => void;
  onRollback?: () => void;
  onSelectProgram?: (path: string | null) => void;
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
  installProgress,
  onInstall,
  onCancelInstall,
  onRollback,
  onSelectProgram,
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
        {card.version && (
          <span className="ac-ver">
            {STRINGS.agents.connectionVersion(card.version)}
          </span>
        )}
        <span className={`ac-state ${card.status}`}>
          {agentStatusLabel(card)}
        </span>
      </div>
      <div className="ac-desc">{card.description}</div>
      <div className="ac-facts">
        {card.localVersion && (
          <span className="ac-fact">
            {STRINGS.agents.localVersion(card.localVersion)}
          </span>
        )}
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
      {!card.custom && (
        <div className="auth-note">
          <div>
            {card.programEnv
              ? STRINGS.install.component
              : STRINGS.install.direct}
          </div>
          <div>{STRINGS.install.disconnectFirst}</div>
          {card.programEnv && (
            <div>
              {STRINGS.install.program}：
              {card.programPath ??
                (card.bundledProgram
                  ? STRINGS.install.bundledProgram
                  : STRINGS.install.pathProgram)}
            </div>
          )}
          {installProgress && (
            <div role="status" aria-live="polite">
              {STRINGS.install.stages[installProgress.stage] ??
                STRINGS.agents.installing}
              {installProgress.bytes !== null &&
                ` ${Math.round(installProgress.bytes / 1024)} KB${installProgress.total ? ` / ${Math.round(installProgress.total / 1024)} KB` : ""}`}
            </div>
          )}
          <div className="ac-actions">
            {card.installable && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={working || connected}
                onClick={onInstall}
              >
                {STRINGS.install.update}
              </button>
            )}
            {busy === "install" && (
              <button
                type="button"
                className="btn btn-text"
                disabled={installProgress?.stage === "cancelling"}
                onClick={onCancelInstall}
              >
                {STRINGS.install.cancel}
              </button>
            )}
            {card.rollbackAvailable && (
              <button
                type="button"
                className="btn btn-text"
                disabled={working || connected}
                onClick={onRollback}
              >
                {STRINGS.install.rollback}
              </button>
            )}
            {card.programEnv && attached && (
              <button
                type="button"
                className="btn btn-text"
                disabled={working || connected}
                onClick={() =>
                  void pickFile({ directory: false, multiple: false })
                    .then((path) => {
                      if (typeof path === "string") onSelectProgram?.(path);
                    })
                    .catch(() => undefined)
                }
              >
                {STRINGS.install.chooseProgram}
              </button>
            )}
            {card.bundledProgram && card.programPath && (
              <button
                type="button"
                className="btn btn-text"
                disabled={working || connected}
                onClick={() => onSelectProgram?.(null)}
              >
                {STRINGS.install.bundled}
              </button>
            )}
            {card.installGuide && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() =>
                  void openUrl(card.installGuide!).catch(() => undefined)
                }
              >
                {STRINGS.install.guide}
              </button>
            )}
          </div>
        </div>
      )}
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
