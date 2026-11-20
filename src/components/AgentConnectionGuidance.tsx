import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { officialLink, type ConnectionGuidance } from "../runtime/preparation";
import { PREPARATION_STRINGS } from "../runtime/preparation_strings";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { uiError } from "../runtime/ui_error";

export function AgentConnectionGuidance({
  items,
  disabled,
}: {
  items: readonly ConnectionGuidance[];
  disabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
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
              disabled={disabled}
              onClick={() => {
                setError(null);
                void openUrl(item.url).catch((reason) =>
                  setError(uiError(reason, PREPARATION_STRINGS.openFailed)),
                );
              }}
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
      {error && (
        <p className="auth-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
