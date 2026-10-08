import { useConnectionAccount } from "../runtime/connection_account";
import { CONNECTION_ACCOUNT_STRINGS as S } from "../runtime/connection_account_strings";
import type { AccountIdentity } from "../runtime/agents";

const labels = S.kinds as Record<AccountIdentity["kind"], string>;

/** Common account presentation; a connection report never proves request availability. */
export function ConnectionAccount({
  agentId,
  cwd,
  source,
  active,
  connectionId,
}: {
  agentId: string;
  cwd: string | null;
  source?: string;
  active: boolean;
  connectionId?: string;
}) {
  const account = useConnectionAccount(
    agentId,
    cwd,
    source,
    active,
    connectionId,
  );
  if (source || !account) return null;
  return (
    <div
      className="journey-connection-summary connection-account-summary"
      aria-label={S.ariaLabel}
    >
      <strong>{labels[account.kind]}</strong>
      {account.email && <span>{account.email}</span>}
      {account.displayName && <span>{account.displayName}</span>}
      {account.plan && <span>{`${S.planPrefix}${account.plan}`}</span>}
      <span className="auth-note">
        {["credential", "missing_credential", "not_required"].includes(
          account.kind,
        )
          ? S.noteAgentChecked
          : S.noteAgentReported}
      </span>
    </div>
  );
}
