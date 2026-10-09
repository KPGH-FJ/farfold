import type { PendingElicitation } from "../runtime/session_types";
import { inquiryUrl } from "../runtime/elicitation";
import { INQUIRY as S } from "../runtime/elicitation_strings";

export function UrlElicitationCard({
  request,
  disabled,
  acceptanceDisabled,
  statusLabel,
  agentName,
  onRespond,
}: {
  request: PendingElicitation;
  disabled?: boolean;
  acceptanceDisabled?: boolean;
  statusLabel?: string;
  agentName?: string;
  onRespond: (action: "accept" | "decline" | "cancel") => void;
}) {
  const target = inquiryUrl(request.url);
  const locked = disabled || request.status !== "pending";
  return (
    <div className="approval elicitation">
      {agentName && <div className="tag">{agentName}</div>}
      {statusLabel && <div role="status">{statusLabel}</div>}
      <div className="ap-title">{request.message}</div>
      <strong>{target?.host}</strong>
      <p style={{ overflowWrap: "anywhere" }}>{request.url}</p>
      <p className="auth-note">
        {S.external} {S.consentOnly}
      </p>
      {target?.hostname.includes("xn--") && <p role="note">{S.suspicious}</p>}
      {(!target || request.error) && (
        <p role="alert">{request.error ?? S.unsafe}</p>
      )}
      {request.handoff && <p role="status">{S.waiting}</p>}
      {!request.handoff && (
        <div className="ap-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              locked || acceptanceDisabled || request.opening || !target
            }
            onClick={() => onRespond("accept")}
          >
            {request.opening ? S.opening : S.open}
          </button>
          <button
            type="button"
            className="btn btn-text"
            disabled={locked}
            onClick={() => onRespond("decline")}
          >
            {S.decline}
          </button>
          <button
            type="button"
            className="btn btn-text"
            disabled={locked}
            onClick={() => onRespond("cancel")}
          >
            {S.cancel}
          </button>
        </div>
      )}
      {request.requestSnapshot !== undefined && (
        <details>
          <summary>{S.details}</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(request.requestSnapshot, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
