import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { officialLink, type ConnectionGuidance } from "../runtime/preparation";
import { PREPARATION_STRINGS } from "../runtime/preparation_strings";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { uiError } from "../runtime/ui_error";

export function AgentConnectionGuidance({
  items,
  disabled,
  owner,
  onReturn,
}: {
  items: readonly ConnectionGuidance[];
  disabled: boolean;
  owner?: string;
  onReturn?: () => void;
}) {
  const current = useRef({ owner, disabled, onReturn });
  current.current = { owner, disabled, onReturn };
  const attempt = useRef<{
    owner: string | undefined;
    awaiting: boolean;
  } | null>(null);
  const [result, setResult] = useState<{
    owner: string | undefined;
    phase: "opening" | "opened" | "failed";
    error?: string;
  } | null>(null);
  const status = result?.owner === owner ? result : null;
  const canCheck = !!onReturn;
  useEffect(() => {
    const returned = () => {
      if (attempt.current?.owner !== owner || !attempt.current?.awaiting)
        return;
      attempt.current = null;
      const view = current.current;
      if (view.owner === owner && !view.disabled) view.onReturn?.();
    };
    const view = typeof window === "undefined" ? null : window;
    const doc = typeof document === "undefined" ? null : document;
    const visible = () => {
      if (doc?.visibilityState === "visible") returned();
    };
    view?.addEventListener("focus", returned);
    doc?.addEventListener("visibilitychange", visible);
    return () => {
      attempt.current = null;
      view?.removeEventListener("focus", returned);
      doc?.removeEventListener("visibilitychange", visible);
    };
  }, [owner]);

  const open = async (url: string) => {
    if (
      current.current.owner !== owner ||
      current.current.disabled ||
      (attempt.current && !attempt.current.awaiting)
    )
      return;
    const opening = { owner, awaiting: false };
    attempt.current = opening;
    setResult({ owner, phase: "opening" });
    try {
      await openUrl(url);
      if (attempt.current !== opening || current.current.owner !== owner)
        return;
      if (current.current.onReturn) opening.awaiting = true;
      else attempt.current = null;
      setResult({ owner, phase: "opened" });
    } catch (reason) {
      if (attempt.current !== opening || current.current.owner !== owner)
        return;
      attempt.current = null;
      setResult({
        owner,
        phase: "failed",
        error: uiError(reason, PREPARATION_STRINGS.openFailed),
      });
    }
  };

  const guides = items.filter((item) => officialLink(item.url));
  if (!guides.length) return null;

  return (
    <div
      className="agent-connection-guidance"
      role="group"
      aria-label={R.officialGuidance}
    >
      <p className="journey-method-group">{R.officialGuidance}</p>
      <ul>
        {guides.map((item) => (
          <li key={`${item.label}:${item.url}`}>
            <button
              className="btn btn-text"
              type="button"
              disabled={disabled || status?.phase === "opening"}
              onClick={() => void open(item.url)}
            >
              {item.label}
              <ArrowSquareOut size={13} aria-hidden="true" />
            </button>
            <small>
              {item.kind === "official_sign_in"
                ? R.officialSignInHint
                : R.officialSetupHint}
              {item.command && (
                <>
                  {" "}
                  <code>{item.command}</code>
                </>
              )}
            </small>
          </li>
        ))}
      </ul>
      {canCheck && status?.phase === "opened" && (
        <button
          className="btn btn-text"
          type="button"
          disabled={disabled}
          onClick={() => {
            if (current.current.owner !== owner || current.current.disabled)
              return;
            attempt.current = null;
            current.current.onReturn?.();
          }}
        >
          {R.checkOfficialSettings}
        </button>
      )}
      {status?.phase === "failed" && (
        <p className="auth-note" role="alert">
          {status.error}
        </p>
      )}
    </div>
  );
}
