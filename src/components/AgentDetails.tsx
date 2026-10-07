import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import {
  getServiceCapabilities,
  type ServiceCapability,
} from "../runtime/credentials";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { agentStatus, type AgentStatus } from "../runtime/agent_status";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
import { AgentLogo } from "./AgentLogo";
import {
  agentDirectoryDescription,
  agentDirectorySource,
} from "../runtime/agent_directory";
import { AGENT_DETAIL_STRINGS as D } from "../runtime/agent_detail_strings";

export function AgentDetails({
  card,
  agents,
  active,
  source,
  onClose,
  onPrepare,
  canStart = false,
  status,
  returnFocusRef,
}: {
  card: AgentCardModel;
  agents: AgentsState;
  active: boolean;
  source: string;
  onClose: () => void;
  onPrepare: () => void;
  canStart?: boolean;
  status?: AgentStatus;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [capability, setCapability] = useState<ServiceCapability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const officialUrl =
    card.presentation?.sourceUrl || card.sourceUrl || card.installGuide;
  useEffect(() => {
    const element = dialog.current;
    const previous = returnFocusRef?.current ?? document.activeElement;
    if (active) element?.showModal();
    else element?.close();
    return () => {
      element?.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest("[hidden], [inert]") &&
        previous.getClientRects().length
      )
        previous.focus();
    };
  }, [active]);
  useEffect(() => {
    let live = true;
    void getServiceCapabilities(card.id)
      .then((value) => {
        if (live) setCapability(value);
      })
      .catch(() => {
        if (live) setCapability(null);
      });
    return () => {
      live = false;
    };
  }, [card.id, card.status]);
  const connected = card.status === "connected";
  const badge = status ?? agentStatus({ card, prepared: canStart });
  return (
    <dialog
      ref={dialog}
      className="agent-setup-dialog agent-detail-dialog"
      aria-labelledby="agent-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="agent-setup-header">
        <h2 id="agent-detail-title">{D.title(card.name)}</h2>
        <button className="icon-btn" aria-label={D.close} onClick={onClose}>
          <X size={19} />
        </button>
      </header>
      <div className="agent-setup-body agent-detail-body">
        <div className="agent-detail-identity">
          <AgentLogo card={card} />
          <div>
            <h3>{card.name}</h3>
            <p>{agentDirectorySource(card) ?? source}</p>
            {card.version && (
              <p>{STRINGS.agents.connectionVersion(card.version)}</p>
            )}
          </div>
          <span className={`agent-hub-badge tone-${badge.tone}`}>
            {badge.label}
          </span>
        </div>
        <p className="agent-detail-description">
          {agentDirectoryDescription(card)}
        </p>
        <section>
          <h4>{D.scope}</h4>
          <p>{S.directoryNote}</p>
          {!!capability?.apiTypes.length && <p>{S.detailApiHint}</p>}
          {capability && !capability.apiTypes.length && <p>{D.noApi}</p>}
          {!capability && <p>{S.detailApiUnknown}</p>}
          <p>{S.detailOfficialHint}</p>
        </section>
        {officialUrl && (
          <div className="agent-detail-links">
            <button
              className="btn btn-text"
              onClick={() =>
                void openUrl(officialUrl).catch((reason) =>
                  setError(uiError(reason, STRINGS.repair.requestFailed)),
                )
              }
            >
              {S.officialPage}
              <ArrowSquareOut size={13} />
            </button>
          </div>
        )}
        {(error || agents.errors[card.id]) && (
          <p role="alert" className="ac-error">
            {error ?? agents.errors[card.id]}
          </p>
        )}
      </div>
      <footer className="agent-setup-footer">
        <span />
        <div>
          <button className="btn btn-ghost" onClick={onClose}>
            {S.detailBack}
          </button>
          <button className="btn btn-primary" onClick={onPrepare}>
            {canStart ? S.start : connected ? S.continueSetup : S.prepare}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
