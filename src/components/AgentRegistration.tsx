import { useRef, useState, useEffect, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut, Globe, UserCircle } from "@phosphor-icons/react";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { PreparationLink } from "../runtime/preparation";
import type { AccountRegistrationProgress } from "../runtime/account_registration";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
import { PREPARATION_STRINGS as S } from "../runtime/preparation_strings";
import { uiError } from "../runtime/ui_error";

export function AgentRegistration({
  links,
  progress,
  onProgress,
  onClose,
  onLogin,
  loginDisabled,
  loginHint,
  returnFocusRef,
}: {
  links: PreparationLink[];
  progress: AccountRegistrationProgress;
  onProgress: (value: AccountRegistrationProgress) => void;
  onClose: () => void;
  onLogin?: () => void;
  loginDisabled?: boolean;
  loginHint?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const attempt = useRef(0);
  const owner = useRef("");
  const key = JSON.stringify([progress.methodId, progress.url, progress.page]);
  owner.current = key;
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const choices = links.filter((link) => link.kind === "account");
  const selected =
    choices.find((link) => link.url === progress.url) ??
    (choices.length === 1 ? choices[0] : undefined);
  const open = async (link: PreparationLink, registration: boolean) => {
    if (opening) return;
    const ticket = ++attempt.current;
    setOpening(true);
    setError(null);
    try {
      await openUrl(link.url);
      if (attempt.current !== ticket || owner.current !== key) return;
      if (registration)
        onProgress({ ...progress, url: link.url, page: "external" });
    } catch (reason) {
      if (attempt.current === ticket && owner.current === key)
        setError(uiError(reason, S.openFailed));
    } finally {
      if (attempt.current === ticket && owner.current === key)
        setOpening(false);
    }
  };
  const close = () => {
    attempt.current++;
    onClose();
  };
  return (
    <WorkspaceDialog
      title={choices.length ? G.createTitle : G.accountInfo}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <section
        className="workspace-dialog-body agent-registration"
        aria-label={choices.length ? G.createTitle : G.accountInfo}
      >
        <button className="btn btn-text" onClick={close}>
          {G.backLogin}
        </button>
        <h3>
          {selected?.label ??
            (choices.length ? G.chooseAccount : G.prepareAccount)}
        </h3>
        <p>{choices.length ? G.accountHint : G.prepareAccountHint}</p>
        {choices.length > 1 && progress.page === "choose" && (
          <div
            className="agent-registration-options"
            role="group"
            aria-label={G.chooseAccount}
          >
            {choices.map((link) => (
              <button
                className="btn btn-ghost"
                key={link.url}
                aria-pressed={selected?.url === link.url}
                disabled={opening}
                onClick={() =>
                  onProgress({ ...progress, url: link.url, page: "choose" })
                }
              >
                <UserCircle size={21} />
                <span>
                  <strong>{link.label}</strong>
                  <small>{new URL(link.url).hostname}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        {selected && (
          <div className="agent-registration-card">
            <Globe size={23} aria-hidden="true" />
            <strong>{new URL(selected.url).hostname}</strong>
            {selected.description && <p>{selected.description}</p>}
            {progress.page === "choose" ? (
              <button
                className="btn btn-primary"
                disabled={opening}
                onClick={() => void open(selected, true)}
              >
                {G.openAccount}
                <ArrowSquareOut size={14} />
              </button>
            ) : (
              <>
                <p role="status">
                  {progress.page === "external" ? G.opened : G.returnedHint}
                </p>
                {progress.page === "external" && (
                  <button
                    className="btn btn-primary"
                    disabled={opening}
                    onClick={() => {
                      if (!opening)
                        onProgress({ ...progress, page: "returned" });
                    }}
                  >
                    {G.returned}
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  disabled={opening}
                  onClick={() => void open(selected, true)}
                >
                  {G.retryOpen}
                </button>
              </>
            )}
          </div>
        )}
        {links
          .filter((link) => link.kind === "documentation")
          .map((link) => (
            <button
              key={link.url}
              className="btn btn-text"
              disabled={opening}
              onClick={() => void open(link, false)}
            >
              {link.label}
              <ArrowSquareOut size={14} />
            </button>
          ))}
        {loginDisabled && loginHint && <p role="status">{loginHint}</p>}
        {error && (
          <p role="alert" className="ac-error">
            {error}
          </p>
        )}
        <p className="auth-note">{G.returnedHint}</p>
      </section>
      <footer>
        <button className="btn btn-ghost" onClick={close}>
          {G.backLogin}
        </button>
        {onLogin && (
          <button
            className="btn btn-primary"
            disabled={loginDisabled || opening}
            onClick={() => {
              if (!loginDisabled && !opening) {
                close();
                onLogin();
              }
            }}
          >
            {G.continueLogin}
          </button>
        )}
      </footer>
    </WorkspaceDialog>
  );
}
