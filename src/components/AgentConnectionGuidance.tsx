import { ArrowSquareOut } from "@phosphor-icons/react";
import { officialLink, type ConnectionGuidance } from "../runtime/preparation";
import { PREPARATION_STRINGS } from "../runtime/preparation_strings";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { uiError } from "../runtime/ui_error";
import { useOfficialPageReturn } from "./useOfficialPageReturn";

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
  const { open, status, checkNow } = useOfficialPageReturn(
    owner,
    true,
    disabled,
    onReturn,
  );

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
      {onReturn && status?.phase === "opened" && (
        <button
          className="btn btn-text"
          type="button"
          disabled={disabled}
          onClick={checkNow}
        >
          {R.checkOfficialSettings}
        </button>
      )}
      {status?.phase === "failed" && (
        <p className="auth-note" role="alert">
          {uiError(status.reason, PREPARATION_STRINGS.openFailed)}
        </p>
      )}
    </div>
  );
}
