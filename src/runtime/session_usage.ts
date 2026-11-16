/** Agent-reported values, in memory only. Never estimate billing or add cumulative reports. */
export interface ReportedUsage {
  used: number | null;
  size: number | null;
  cost?: { amount: number; currency: string };
}

export interface ReportedTokens {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function reportedUsage(value: unknown): ReportedUsage | null {
  const data = record(value);
  const validContext = count(data.used) && count(data.size);
  const rawCost = record(data.cost);
  const cost =
    typeof rawCost.amount === "number" &&
    Number.isFinite(rawCost.amount) &&
    rawCost.amount >= 0 &&
    typeof rawCost.currency === "string" &&
    /^[A-Z]{3}$/.test(rawCost.currency)
      ? { amount: rawCost.amount, currency: rawCost.currency }
      : undefined;
  if (!validContext && !cost) return null;
  return {
    used: validContext ? (data.used as number) : null,
    size: validContext ? (data.size as number) : null,
    ...(cost ? { cost } : {}),
  };
}

export function reportedTokens(value: unknown): ReportedTokens | null {
  const data = record(value);
  if (
    !count(data.totalTokens) ||
    !count(data.inputTokens) ||
    !count(data.outputTokens)
  )
    return null;
  const tokens: ReportedTokens = {
    totalTokens: data.totalTokens,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
  };
  for (const field of [
    "thoughtTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
  ] as const) {
    if (count(data[field])) tokens[field] = data[field];
  }
  return tokens;
}

export function contextPercent(usage: ReportedUsage | null): string | null {
  if (usage?.used == null || usage.size == null || usage.size === 0)
    return null;
  const percent = (usage.used / usage.size) * 100;
  // Avoid claiming an exhausted window when rounding a value just below 100%.
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent < 100 && percent >= 99.9) return "<100%";
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(percent)}%`;
}

export const USAGE_STRINGS = {
  title: "对话用量",
  compact: "用量",
  context: "上下文",
  contextCapacity: "上下文容量",
  cost: "累计费用",
  total: "累计用量",
  accumulatedInput: "累计输入",
  accumulatedOutput: "累计输出",
  input: "输入",
  output: "输出",
  thought: "思考",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
  unknown: "尚未提供",
  note: "以上是 Agent 最近一次提供的数据。累计用量和费用覆盖本对话，实际计费以服务方账单为准。",
  disconnected: "连接已断开，以下为断开前收到的数据。",
  stale: "当前对话尚未恢复可用，以下为此前收到的数据。",
  empty: "Agent 尚未提供有效的用量信息。",
};
