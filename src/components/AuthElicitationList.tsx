import {
  authActive,
  type AuthActivity,
  type AuthActivitySnapshot,
} from "../runtime/auth_activity";
import { INQUIRY as S } from "../runtime/elicitation_strings";
import { ElicitationCard } from "./ElicitationCard";

export function AuthElicitationList({
  activity,
  job,
  agentName,
}: {
  activity: AuthActivity;
  job: AuthActivitySnapshot;
  agentName: string;
}) {
  const disabled =
    !activity.canStart(job.attemptId) ||
    !authActive(job) ||
    ["checking", "cancelling"].includes(job.phase);
  return (
    <>
      {job.inquiryNotice && (
        <p className="auth-note" role="status">
          {job.inquiryNotice}
        </p>
      )}
      {job.inquiryDetail !== undefined && (
        <details>
          <summary>{S.details}</summary>
          <pre>{JSON.stringify(job.inquiryDetail, null, 2)}</pre>
        </details>
      )}
      {job.inquiries?.map((request) => (
        <ElicitationCard
          key={request.requestId}
          request={request}
          disabled={disabled}
          agentName={agentName}
          onChange={(name, value) =>
            activity.editInquiry(request.requestId, name, value)
          }
          onRespond={(action, values) => {
            void activity.replyInquiry(request.requestId, action, values);
          }}
        />
      ))}
    </>
  );
}
