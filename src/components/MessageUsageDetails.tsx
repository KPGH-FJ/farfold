import type { ReceivedMessageUsage } from "../runtime/message_usage";
import { USAGE_STRINGS as U } from "../runtime/session_usage";

const tokens = (n: number | null) =>
  n == null ? U.unknown : `${n.toLocaleString("zh-CN")} tokens`;
const duration = (n: number | null) =>
  n == null ? U.unknown : `${n.toLocaleString("zh-CN")} ms`;

/** The latest delivered message report can also come from older history. */
export function MessageUsageDetails({
  usage,
}: {
  usage: ReceivedMessageUsage;
}) {
  return (
    <section
      aria-label="最近收到的单条消息报告"
      className="thread-message-usage"
    >
      <h3>最近收到的单条消息报告</h3>
      <p>
        仅代表这一条报告，不计入上方累计值，也不代表当前上下文。本报告未与对话中的具体消息关联。
      </p>
      <dl>
        <dt>收到时间</dt>
        <dd>
          {new Date(usage.receivedAtMs).toLocaleTimeString("zh-CN", {
            hour12: false,
          })}
        </dd>
        <dt>{U.input}</dt>
        <dd>{tokens(usage.inputTokens)}</dd>
        <dt>{U.output}</dt>
        <dd>{tokens(usage.outputTokens)}</dd>
        <dt>报告总量</dt>
        <dd>{tokens(usage.totalTokens)}</dd>
        <dt>{U.cacheRead}</dt>
        <dd>{tokens(usage.cacheReadTokens)}</dd>
        <dt>{U.cacheWrite}</dt>
        <dd>{tokens(usage.cacheWriteTokens)}</dd>
        <dt>报告费用</dt>
        <dd>
          {usage.cost == null ? U.unknown : `${usage.cost}（币种未提供）`}
        </dd>
        <dt>费用来源</dt>
        <dd>
          {usage.costSource === "provider_reported"
            ? "服务方报告"
            : usage.costSource === "estimated"
              ? "估算"
              : U.unknown}
        </dd>
        <dt>报告耗时</dt>
        <dd>{duration(usage.elapsedMs)}</dd>
        <dt>首个 token 等待</dt>
        <dd>{duration(usage.timeToFirstTokenMs)}</dd>
        <dt>来自整理调用</dt>
        <dd>
          {usage.isCompaction == null
            ? U.unknown
            : usage.isCompaction
              ? "是"
              : "否"}
        </dd>
      </dl>
      <p>
        收到时间可能对应旧消息重发；报告耗时由 Agent
        提供。整理调用标记不代表整理已完成，实际计费以服务方账单为准。
      </p>
    </section>
  );
}
