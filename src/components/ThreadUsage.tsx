import type { ThreadState } from "../runtime/session_types";
import { contextPercent, USAGE_STRINGS as U } from "../runtime/session_usage";
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
  const total = thread.sessionTokens;
  return (
    <div className="thread-usage-details">
      {priorReport(thread) && (
        <p role="status">{thread.connectionLost ? U.disconnected : U.stale}</p>
      )}
      {!usage && !total && <p>{U.empty}</p>}
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
        {total && (
          <>
            <dt>{U.input}</dt>
            <dd>{tokens(total.inputTokens)}</dd>
            <dt>{U.output}</dt>
            <dd>{tokens(total.outputTokens)}</dd>
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
