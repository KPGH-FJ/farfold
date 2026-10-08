import type { ReactNode } from "react";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";
import type { AuthenticationWorkBlocker } from "../runtime/auth_blockers";
import type { AgentConnectionPresentation } from "./agent_auth_types";
import { DangerConfirm } from "./DangerConfirm";
import { STRINGS } from "../runtime/strings";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";

const A = STRINGS.agents.auth;

/** The collapsed management utilities behind the method list. */
export function AgentAuthManage({
  accountOptions,
  modelsAvailable,
  canOpenModels,
  managed,
  occupied,
  busy,
  workBlocked,
  checkBlocked,
  directoryReady,
  onOpenModels,
  onRecheck,
  onChangeConnection,
  completedLabel,
  completedDisabled,
  onManageCompleted,
  canLogout,
  canSwitch,
  accountExitAvailable,
  onAccountExit,
}: {
  accountOptions: ReactNode;
  modelsAvailable: boolean;
  canOpenModels: boolean;
  /** Inside a connection flow the models shortcut is hidden. */
  managed: boolean;
  occupied: boolean;
  busy: boolean;
  workBlocked: boolean;
  checkBlocked: boolean;
  directoryReady: boolean;
  onOpenModels?: () => void;
  onRecheck: () => void;
  onChangeConnection: () => void;
  /** Reopen/manage action for the completed method, when one exists. */
  completedLabel?: string | null;
  completedDisabled?: boolean;
  onManageCompleted?: () => void;
  canLogout: boolean;
  canSwitch: boolean;
  accountExitAvailable: boolean;
  onAccountExit: (intent: "logout" | "switch") => void;
}) {
  return (
    <details className="journey-details agent-account-more">
      <summary>{R.manage}</summary>
      {accountOptions}
      <div className="auth-actions journey-utilities">
        {modelsAvailable && onOpenModels && !managed && (
          <button
            className="btn btn-text"
            disabled={!canOpenModels || occupied || workBlocked || checkBlocked}
            onClick={onOpenModels}
          >
            {S.models}
          </button>
        )}
        <button
          className="btn btn-text"
          disabled={occupied || busy || checkBlocked || !directoryReady}
          onClick={onRecheck}
        >
          {R.connection}
        </button>
        <button
          className="btn btn-text"
          disabled={occupied || workBlocked}
          onClick={onChangeConnection}
        >
          {R.change}
        </button>
        {completedLabel && (
          <button
            className="btn btn-text"
            disabled={completedDisabled}
            onClick={onManageCompleted}
          >
            {completedLabel}
          </button>
        )}
        {canLogout && (
          <>
            <button
              className="btn btn-text"
              disabled={!accountExitAvailable}
              onClick={() => onAccountExit("logout")}
            >
              {A.logout}
            </button>
            {canSwitch && (
              <button
                className="btn btn-text"
                disabled={!accountExitAvailable}
                onClick={() => onAccountExit("switch")}
              >
                {S.switchAccount}
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/** Confirmation for logout or switch-account before the operation starts. */
export function AgentAccountExit({
  intent,
  available,
  onCancel,
  onConfirm,
}: {
  intent: "logout" | "switch";
  available: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <section aria-label={intent === "switch" ? S.switchAccount : A.logout}>
      <DangerConfirm
        confirmLabel={intent === "switch" ? S.switchConfirm : S.confirmLogout}
        confirmDisabled={!available}
        onConfirm={onConfirm}
        cancelLabel={STRINGS.access.cancel}
        onCancel={onCancel}
      >
        <p className="auth-note">
          {intent === "switch" ? S.switchHint : S.logoutHint}
        </p>
      </DangerConfirm>
    </section>
  );
}

/** The blocking-work list shown while account mutations must wait. */
export function AgentAuthWorkBlockers({
  blockers,
  agentName,
  onOpenConversation,
}: {
  blockers: AuthenticationWorkBlocker[];
  agentName?: string;
  onOpenConversation?: (key: string) => void;
}) {
  if (!blockers.length) return null;
  return (
    <section aria-label={S.workHeading}>
      <h4>{S.workHeading}</h4>
      <p className="auth-note">
        {agentName ? S.workBusy(agentName) : S.workHint}
      </p>
      <div role="list">
        {blockers.map((work) => (
          <div className="auth-row" role="listitem" key={work.key}>
            <div>
              <div className="auth-name">{work.title}</div>
              <div className="auth-desc">{work.reason}</div>
              {!work.canOpen && <p className="auth-note">{S.workDraft}</p>}
            </div>
            {work.canOpen && onOpenConversation && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => onOpenConversation(work.key)}
              >
                {S.workOpen}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Progress and retry for the saved-settings verification. */
export function AgentExistingVerify({
  verify,
}: {
  verify: NonNullable<AgentConnectionPresentation["existingVerify"]>;
}) {
  return (
    <div className="auth-progress">
      <div className="auth-note" role="status">
        {verify.status === "checking"
          ? R.existingChecking
          : verify.status === "ready"
            ? R.existingReady
            : verify.error}
      </div>
      {verify.status === "failed" && verify.onRetry && (
        <button className="btn btn-ghost" onClick={verify.onRetry}>
          {STRINGS.access.retry}
        </button>
      )}
    </div>
  );
}
