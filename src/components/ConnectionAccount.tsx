import { useConnectionAccount } from "../runtime/connection_account";
import { CONNECTION_ACCOUNT_STRINGS as S } from "../runtime/connection_account_strings";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";
import type { AccountIdentity } from "../runtime/agents";
import type { ThreadState } from "../runtime/session_types";
import { SessionIdentityControl } from "./SessionIdentityControl";

const labels = S.kinds as Record<AccountIdentity["kind"], string>;

/** Common account presentation; a connection report never proves request availability. */
export function ConnectionAccount({
  agentId,
  cwd,
  source,
  active,
  connectionId,
  thread,
}: {
  agentId: string;
  cwd: string | null;
  source?: string;
  active: boolean;
  connectionId?: string;
  thread?: ThreadState;
}) {
  const account = useConnectionAccount(
    agentId,
    cwd,
    source,
    active,
    connectionId,
  );
  if (!active) return null;
  return (
    <>
      {!source && (
        <div
          className="journey-connection-summary connection-account-summary"
          aria-label={S.ariaLabel}
        >
          <dl className="agent-current-facts">
            <div>
              <dt>{U.identity}</dt>
              <dd>
                {[account?.email, account?.displayName]
                  .filter(Boolean)
                  .join(" · ") || U.identityUnknown}
              </dd>
            </div>
            <div>
              <dt>{U.authentication}</dt>
              <dd>{account ? labels[account.kind] : U.notRead}</dd>
            </div>
            <div>
              <dt>{U.accountPlan}</dt>
              <dd>{account?.plan || U.planUnknown}</dd>
            </div>
          </dl>
          <details className="agent-evidence-details">
            <summary>{U.evidenceScope}</summary>
            <p className="auth-note">{U.identityUnknownHint}</p>
            {account && (
              <p className="auth-note">
                {["credential", "missing_credential", "not_required"].includes(
                  account.kind,
                )
                  ? S.noteAgentChecked
                  : S.noteAgentReported}
              </p>
            )}
          </details>
        </div>
      )}
      {thread && <SessionIdentityControl thread={thread} active={active} />}
    </>
  );
}
