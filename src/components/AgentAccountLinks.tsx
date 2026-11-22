import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import {
  getAgentPreparation,
  officialLink,
  type PreparationLink,
} from "../runtime/preparation";
import { PREPARATION_STRINGS as S } from "../runtime/preparation_strings";
import { uiError } from "../runtime/ui_error";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
import { useOfficialPageReturn } from "./useOfficialPageReturn";

/** Inline account access: registration entry plus small documentation links.
 *  Opening an external page arms a one-shot focus return check owned by the
 *  caller; verification itself stays read-only. */
export function AgentAccountLinks({
  agentId,
  methodIds,
  agentName,
  websiteUrl,
  owner,
  onReturn,
  disabled = false,
  active = true,
}: {
  agentId: string;
  methodIds?: string[];
  agentName: string;
  websiteUrl?: string | null;
  owner?: string;
  /** Fired once when the window is focused again after opening a page. */
  onReturn?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const [links, setLinks] = useState<PreparationLink[]>([]);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const targetKey = JSON.stringify([agentId, methodIds ?? null]);
  const linksOwner = useRef(targetKey);
  const currentLinks = linksOwner.current === targetKey ? links : [];
  const page = useOfficialPageReturn(
    JSON.stringify([owner, targetKey]),
    active,
    disabled,
    onReturn,
  );
  const opening = page.status?.phase === "opening";
  const error =
    page.status?.phase === "failed"
      ? uiError(page.status.reason, S.openFailed)
      : preparationError;
  useEffect(() => {
    let active = true;
    setLinks([]);
    setPreparationError(null);
    void getAgentPreparation(agentId)
      .then((info) => {
        if (active) {
          linksOwner.current = targetKey;
          const scoped = (info.links ?? []).filter(
            (link) =>
              officialLink(link.url) &&
              (!link.methodIds?.length ||
                (methodIds ?? []).some((id) => link.methodIds!.includes(id))),
          );
          setLinks(scoped);
        }
      })
      .catch((reason) => {
        if (active) setPreparationError(uiError(reason, S.accountFailed));
      });
    return () => {
      active = false;
    };
  }, [agentId, targetKey, reload]);
  const open = (url: string, registration: boolean) => {
    if (!active || opening || disabled) return;
    setPreparationError(null);
    void page.open(url, registration);
  };
  const accounts = currentLinks.filter((link) => link.kind === "account");
  const docs = currentLinks.filter((link) => link.kind === "documentation");
  const site = websiteUrl && officialLink(websiteUrl) ? websiteUrl : null;
  const hostname = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  return (
    <div className="agent-account-inline">
      {accounts.length === 1 ? (
        <button
          className="btn btn-text"
          disabled={!active || disabled || opening}
          onClick={() => open(accounts[0].url, true)}
        >
          {G.register}
          <ArrowSquareOut size={13} aria-hidden="true" />
        </button>
      ) : accounts.length > 1 ? (
        <span className="agent-account-inline-list">
          {G.registerChoose}
          {accounts.map((link) => (
            <button
              key={link.url}
              className="btn btn-text"
              disabled={!active || disabled || opening}
              onClick={() => open(link.url, true)}
            >
              {hostname(link.url)}
              <ArrowSquareOut size={12} aria-hidden="true" />
            </button>
          ))}
        </span>
      ) : site ? (
        <button
          className="btn btn-text"
          disabled={!active || disabled || opening}
          onClick={() => open(site, true)}
        >
          {G.registerSite(agentName)}
          <ArrowSquareOut size={13} aria-hidden="true" />
        </button>
      ) : (
        <p className="auth-note">{G.registerChannels(agentName)}</p>
      )}
      {docs.map((link) => (
        <button
          key={link.url}
          className="btn btn-text agent-account-docs"
          disabled={!active || disabled || opening}
          onClick={() => open(link.url, false)}
        >
          {G.docs}
          <ArrowSquareOut size={12} aria-hidden="true" />
        </button>
      ))}
      {error && (
        <span role="alert" className="auth-note">
          {error}{" "}
          <button
            className="btn btn-text"
            onClick={() => {
              page.clear();
              setReload((value) => value + 1);
            }}
          >
            {S.retry}
          </button>
        </span>
      )}
    </div>
  );
}
