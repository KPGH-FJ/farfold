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
import { useModalDialog } from "./useModalDialog";
import {
  agentDirectoryDescription,
  agentDirectorySource,
} from "../runtime/agent_directory";
import { AGENT_DETAIL_STRINGS as D } from "../runtime/agent_detail_strings";

/** Public capability snapshot shape (`Handshake::public_json`, camelCase). */
interface DeclaredCapabilities {
  authMethods: { id?: string; name?: string; type?: string }[];
  loadSession: boolean | null;
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  logout: boolean;
  known: boolean;
}

/** Read only declared fields from the stored public handshake snapshot. */
export function declaredCapabilities(
  card: Pick<AgentCardModel, "handshake">,
): DeclaredCapabilities {
  const handshake = card.handshake as {
    authMethods?: { id?: string; name?: string; type?: string }[];
    agentCapabilities?: {
      loadSession?: boolean;
      promptCapabilities?: {
        image?: boolean;
        audio?: boolean;
        embeddedContext?: boolean;
      };
      auth?: { logout?: unknown };
    };
  } | null;
  const prompt = handshake?.agentCapabilities?.promptCapabilities;
  return {
    authMethods: Array.isArray(handshake?.authMethods)
      ? handshake.authMethods
      : [],
    loadSession:
      handshake?.agentCapabilities?.loadSession === true
        ? true
        : handshake
          ? false
          : null,
    prompt: {
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true,
    },
    logout: handshake?.agentCapabilities?.auth?.logout != null,
    known: handshake != null,
  };
}

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
  const { onCancel, onClick } = useModalDialog({
    dialogRef: dialog,
    open: active,
    onDismiss: onClose,
    returnFocusRef,
    backdropDismiss: true,
  });
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
  const declared = declaredCapabilities(card);
  const promptItems = [
    declared.prompt.image && D.capabilityPromptImage,
    declared.prompt.audio && D.capabilityPromptAudio,
    declared.prompt.embeddedContext && D.capabilityPromptContext,
  ].flatMap((item) => (item ? [item] : []));
  return (
    <dialog
      ref={dialog}
      className="agent-setup-dialog agent-detail-dialog"
      aria-labelledby="agent-detail-title"
      onCancel={onCancel}
      onClick={onClick}
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
        <section className="agent-detail-capabilities">
          <h4>{D.capabilities}</h4>
          <dl>
            <div>
              <dt>{D.capabilityAuth}</dt>
              <dd>
                {declared.known
                  ? declared.authMethods.length
                    ? `${D.capabilityAuthCount(declared.authMethods.length)}：${declared.authMethods
                        .map((method) => method.name ?? method.id ?? "")
                        .filter(Boolean)
                        .join("、")}`
                    : D.capabilityAuthNone
                  : D.capabilityAuthUnknown}
              </dd>
            </div>
            <div>
              <dt>{D.capabilityContent}</dt>
              <dd>
                {promptItems.length
                  ? D.capabilityContentList(promptItems)
                  : D.capabilityContentNone}
              </dd>
            </div>
            <div>
              <dt>{D.capabilityHistory}</dt>
              <dd>
                {declared.loadSession === true
                  ? D.capabilityHistoryDeclared
                  : D.capabilityHistoryUnknown}
              </dd>
            </div>
            <div>
              <dt>{D.capabilityApi}</dt>
              <dd>
                {capability
                  ? capability.apiTypes.length
                    ? D.capabilityApiYes
                    : D.capabilityApiNo
                  : D.capabilityApiUnknown}
              </dd>
            </div>
          </dl>
          <p className="auth-note">{D.capabilityHonesty}</p>
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
            {D.close}
          </button>
          <button className="btn btn-primary" onClick={onPrepare}>
            {canStart ? S.start : connected ? S.continueSetup : S.prepare}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
