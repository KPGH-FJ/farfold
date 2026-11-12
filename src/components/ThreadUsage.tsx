import type { ThreadState } from "../runtime/session_types";
import { contextPercent, USAGE_STRINGS as U } from "../runtime/session_usage";
import { getMessageUsage } from "../runtime/message_usage";
import { getSessionCumulativeTokens } from "../runtime/session_usage_notification";
import { MessageUsageDetails } from "./MessageUsageDetails";
import { WorkspacePopover } from "./WorkspacePopover";
import "../thread-usage.css";

const tokens = (count: number | null | undefined) =>
  count == null ? U.unknown : `${count.toLocaleString("zh-CN")} tokens`;

const priorReport = (thread: ThreadState) =>
  Boolean(
    thread.connectionLost ||
    thread.reconnecting ||
    thread.openError ||
    thread.historyUnavailable ||
    thread.sourceError,
  );

export function ThreadUsageDetails({ thread }: { thread: ThreadState }) {
  const usage = thread.usage;
  const cumulative = getSessionCumulativeTokens(thread);
  // These are separate official reports. Never attach older totals/cache values
  // to a newer pair of counters that did not report those fields.
  const total = cumulative ? null : thread.sessionTokens;
  const message = getMessageUsage(thread);
  return (
    <div className="thread-usage-details">
      {priorReport(thread) && (
        <p role="status">{thread.connectionLost ? U.disconnected : U.stale}</p>
      )}
      {!usage && !total && !cumulative && !message && <p>{U.empty}</p>}
      <dl>
        <dt>{U.context}</dt>
        <dd>{tokens(usage?.used)}</dd>
        <dt>{U.contextCapacity}</dt>
        <dd>{tokens(usage?.size)}</dd>
        <dt>{U.cost}</dt>
        <dd>
          {usage?.cost
            ? `${usage.cost.amount} ${usage.cost.currency}`
            : U.unknown}
        </dd>
        <dt>{U.total}</dt>
        <dd>{tokens(total?.totalTokens)}</dd>
        <dt>{U.accumulatedInput}</dt>
        <dd>{tokens(cumulative?.inputTokens ?? total?.inputTokens)}</dd>
        <dt>{U.accumulatedOutput}</dt>
        <dd>{tokens(cumulative?.outputTokens ?? total?.outputTokens)}</dd>
        {total && (
          <>
            {total.thoughtTokens != null && (
              <>
                <dt>{U.thought}</dt>
                <dd>{tokens(total.thoughtTokens)}</dd>
              </>
            )}
            {total.cachedReadTokens != null && (
              <>
                <dt>{U.cacheRead}</dt>
                <dd>{tokens(total.cachedReadTokens)}</dd>
              </>
            )}
            {total.cachedWriteTokens != null && (
              <>
                <dt>{U.cacheWrite}</dt>
                <dd>{tokens(total.cachedWriteTokens)}</dd>
              </>
            )}
          </>
        )}
      </dl>
      <p>{U.note}</p>
      {message && <MessageUsageDetails usage={message} />}
    </div>
  );
}

export function ThreadUsage({
  thread,
  disabled = false,
}: {
  thread: ThreadState;
  disabled?: boolean;
}) {
  const percent = !priorReport(thread) ? contextPercent(thread.usage) : null;
  return (
    <WorkspacePopover
      className="thread-usage-control"
      title={U.title}
      disabled={disabled}
      label={percent ? `${U.context} ${percent}` : U.compact}
    >
      <ThreadUsageDetails thread={thread} />
    </WorkspacePopover>
  );
}
