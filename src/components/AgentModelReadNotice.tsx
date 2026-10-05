import { AGENT_SETUP_STRINGS as S } from "../runtime/agent_setup_strings";

export function AgentModelReadNotice({
  mismatch,
  disabled,
  onConfirm,
}: {
  mismatch: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  if (!mismatch) return null;
  return (
    <div className="auth-note" role="alert">
      <p>{S.modelMismatch}</p>
      <button className="btn btn-text" disabled={disabled} onClick={onConfirm}>
        {S.modelAcceptCurrent}
      </button>
    </div>
  );
}
