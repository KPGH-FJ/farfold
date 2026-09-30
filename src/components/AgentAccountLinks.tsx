import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getAgentPreparation,
  accountLinksForMethod,
  type PreparationLink,
} from "../runtime/preparation";
import { PREPARATION_STRINGS as S } from "../runtime/preparation_strings";
import { uiError } from "../runtime/ui_error";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
import {
  currentAccountRegistration,
  type AccountRegistrationProgress,
} from "../runtime/account_registration";
import { AgentRegistration } from "./AgentRegistration";

export function AgentAccountLinks({
  agentId,
  methodId,
  registration,
  onRegistrationChange,
  onContinueLogin,
  loginDisabled,
  loginHint,
  active = true,
}: {
  agentId: string;
  methodId?: string;
  registration?: AccountRegistrationProgress;
  onRegistrationChange?: (
    value: AccountRegistrationProgress | undefined,
  ) => void;
  onContinueLogin?: () => void;
  loginDisabled?: boolean;
  loginHint?: string;
  active?: boolean;
}) {
  const [links, setLinks] = useState<PreparationLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [localRegistration, setLocalRegistration] = useState<
    AccountRegistrationProgress | undefined
  >();
  const target = useRef("");
  const registrationTrigger = useRef<HTMLButtonElement | null>(null);
  const targetKey = JSON.stringify([agentId, methodId]);
  const linksOwner = useRef(targetKey);
  const currentLinks = linksOwner.current === targetKey ? links : [];
  target.current = targetKey;
  useEffect(() => {
    let active = true;
    setLinks([]);
    setError(null);
    setLocalRegistration(undefined);
    void getAgentPreparation(agentId)
      .then((info) => {
        if (active) {
          linksOwner.current = targetKey;
          setLinks(accountLinksForMethod(info.links, methodId));
        }
      })
      .catch((reason) => {
        if (active) setError(uiError(reason, S.accountFailed));
      });
    return () => {
      active = false;
    };
  }, [agentId, methodId, reload]);
  const page = currentAccountRegistration(
    onRegistrationChange ? registration : localRegistration,
    methodId,
    currentLinks,
  );
  const setPage = onRegistrationChange ?? setLocalRegistration;
  if (!currentLinks.length && !error) return null;
  return (
    <section className="agent-account-links" aria-label={S.account}>
      {!!currentLinks.length && (
        <button
          ref={registrationTrigger}
          className="btn btn-ghost"
          onClick={(event) => {
            registrationTrigger.current = event.currentTarget;
            setPage({ methodId: methodId ?? "", url: "", page: "choose" });
          }}
        >
          {currentLinks.some((link) => link.kind === "account")
            ? G.create
            : G.accountInfo}
        </button>
      )}
      <details className="agent-account-more">
        <summary>{P.accountLinks}</summary>
        <p className="auth-note">{S.accountHint}</p>
        {currentLinks.map((link) => (
          <div key={link.url}>
            {link.kind === "documentation" && (
              <button
                className="btn btn-text"
                onClick={() =>
                  void openUrl(link.url).catch((reason) => {
                    if (target.current === targetKey)
                      setError(uiError(reason, S.openFailed));
                  })
                }
              >
                {link.label}
                <ArrowSquareOut size={14} aria-hidden="true" />
              </button>
            )}
            {link.description && (
              <p className="auth-note">{link.description}</p>
            )}
          </div>
        ))}
      </details>
      {active && page && currentLinks.length > 0 && (
        <AgentRegistration
          key={targetKey}
          links={currentLinks}
          progress={page}
          onProgress={setPage}
          onClose={() => setPage(undefined)}
          onLogin={onContinueLogin}
          loginDisabled={loginDisabled}
          loginHint={loginHint}
          returnFocusRef={registrationTrigger}
        />
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="btn btn-text"
            onClick={() => setReload((value) => value + 1)}
          >
            {S.retry}
          </button>
        </div>
      )}
    </section>
  );
}
