import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";

export function agentSetupErrorNotice(
  error: string | null | undefined,
  retry?: () => void,
) {
  if (!error) return null;
  return (
    <div role="alert" className="ac-error">
      {error}
      {retry && (
        <button className="btn btn-text" onClick={retry}>
          {S.retry}
        </button>
      )}
    </div>
  );
}

export function agentSetupPendingNotices({
  waiting,
  authenticating,
  configuring,
  openConversation,
  resume,
}: {
  waiting: boolean;
  authenticating: boolean;
  configuring: boolean;
  openConversation?: () => void;
  resume: () => void;
}) {
  return (
    <>
      {waiting && (
        <div className="agent-setup-notice" role="status">
          <p>{S.otherTestPending}</p>
          {openConversation && (
            <button className="btn btn-ghost" onClick={openConversation}>
              {S.testOpen}
            </button>
          )}
        </div>
      )}
      {authenticating && (
        <div className="agent-setup-notice" role="status">
          <p>{configuring ? C.busy : S.loginBusy}</p>
          <button className="btn btn-ghost" onClick={resume}>
            {configuring ? C.resume : S.resumeLogin}
          </button>
        </div>
      )}
    </>
  );
}
