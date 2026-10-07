import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut } from "@phosphor-icons/react";
import {
  getAgentPreparation,
  officialLink,
  type PreparationLink,
} from "../runtime/preparation";
import { PREPARATION_STRINGS as S } from "../runtime/preparation_strings";
import { uiError } from "../runtime/ui_error";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";

/** Inline account access: registration entry plus small documentation links.
 *  Opening an external page arms a one-shot focus return check owned by the
 *  caller; verification itself stays read-only. */
export function AgentAccountLinks({
  agentId,
  methodIds,
  agentName,
  websiteUrl,
  onReturn,
  disabled = false,
  active = true,
}: {
  agentId: string;
  methodIds?: string[];
  agentName: string;
  websiteUrl?: string | null;
  /** Fired once when the window is focused again after opening a page. */
  onReturn?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const [links, setLinks] = useState<PreparationLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [reload, setReload] = useState(0);
  const target = useRef("");
  const targetKey = JSON.stringify([agentId, methodIds ?? null]);
  const linksOwner = useRef(targetKey);
  const currentLinks = linksOwner.current === targetKey ? links : [];
  const awaiting = useRef(false);
  const returnAction = useRef<(() => void) | undefined>(undefined);
  returnAction.current = onReturn;
  target.current = targetKey;
  useEffect(() => {
    awaiting.current = false;
  }, [agentId]);
  useEffect(() => {
    let active = true;
    setLinks([]);
    setError(null);
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
        if (active) setError(uiError(reason, S.accountFailed));
      });
    return () => {
      active = false;
    };
  }, [agentId, targetKey, reload]);
  useEffect(() => {
    if (!active) return;
    const returned = () => {
      if (!awaiting.current) return;
      awaiting.current = false;
      returnAction.current?.();
    };
    const view = typeof window === "undefined" ? null : window;
    const doc = typeof document === "undefined" ? null : document;
    const onFocus = () => returned();
    const onVisible = () => {
      if (doc?.visibilityState === "visible") returned();
    };
    view?.addEventListener?.("focus", onFocus);
    doc?.addEventListener?.("visibilitychange", onVisible);
    return () => {
      view?.removeEventListener?.("focus", onFocus);
      doc?.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [active]);
  const open = (url: string, registration: boolean) => {
    if (opening || disabled) return;
    setOpening(true);
    setError(null);
    void openUrl(url)
      .then(() => {
        if (target.current === targetKey && registration)
          awaiting.current = true;
      })
      .catch((reason) => {
        if (target.current === targetKey)
          setError(uiError(reason, S.openFailed));
      })
      .finally(() => {
        if (target.current === targetKey) setOpening(false);
      });
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
          disabled={disabled || opening}
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
              disabled={disabled || opening}
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
          disabled={disabled || opening}
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
          disabled={disabled || opening}
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
            onClick={() => setReload((value) => value + 1)}
          >
            {S.retry}
          </button>
        </span>
      )}
    </div>
  );
}
