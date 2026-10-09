import { AGENT_SETUP_STRINGS as S } from "../runtime/agent_setup_strings";
import type { ReactNode } from "react";

export function AgentModelReadNotice({
  mismatch,
  disabled,
  onConfirm,
  children,
}: {
  mismatch: boolean;
  disabled: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  if (!mismatch) return null;
  return (
    <div className="auth-note" role="alert">
      <p>{S.modelMismatch}</p>
      {children}
      <button className="btn btn-text" disabled={disabled} onClick={onConfirm}>
        {S.modelAcceptCurrent}
      </button>
    </div>
  );
}
