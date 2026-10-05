import { CONNECTION_STRINGS as S } from "../runtime/r5_auth_strings";

/** Every account detail shares the same title and return placement. */
export function AgentAccountHeading({
  title,
  onBack,
  disabled,
}: {
  title: string;
  onBack?: () => void;
  disabled: boolean;
}) {
  return (
    <div className="agent-account-heading">
      <h3>{title}</h3>
      {onBack && (
        <button
          type="button"
          className="btn btn-ghost agent-account-back"
          disabled={disabled}
          onClick={onBack}
        >
          {S.backMethod}
        </button>
      )}
    </div>
  );
}
