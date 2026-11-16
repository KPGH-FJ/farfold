import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { freshThreadState } from "../runtime/session_projection";
import { ThreadUsage, ThreadUsageDetails } from "./ThreadUsage";

it("renders unavailable values distinctly from reported zero and small exact cost", () => {
  const thread = freshThreadState("one", "fixture", "/fixture", "one");
  const empty = renderToStaticMarkup(<ThreadUsageDetails thread={thread} />);
  expect(empty).toContain("尚未提供");
  expect(empty).not.toContain("0 tokens");
  thread.usage = {
    used: 0,
    size: 1000,
    cost: { amount: 0.000001, currency: "USD" },
  };
  const known = renderToStaticMarkup(<ThreadUsageDetails thread={thread} />);
  expect(known).toContain("0 tokens");
  expect(known).toContain("1,000 tokens");
  expect(known).toContain("0.000001 USD");
  expect(known).toContain("累计费用");
  expect(known).toContain("实际计费以服务方账单为准");
});

it("shows reported cumulative fields and labels disconnected data", () => {
  const thread = freshThreadState("one", "fixture", "/fixture", "one");
  thread.usage = { used: 50, size: 100 };
  thread.sessionTokens = {
    totalTokens: 300,
    inputTokens: 180,
    outputTokens: 120,
    thoughtTokens: 20,
  };
  thread.connectionLost = true;
  const html = renderToStaticMarkup(<ThreadUsageDetails thread={thread} />);
  expect(html).toContain("连接已断开");
  expect(html).toContain("300 tokens");
  expect(html).not.toContain("本轮用量");
  const control = renderToStaticMarkup(<ThreadUsage thread={thread} />);
  expect(control).toContain('aria-haspopup="dialog"');
  expect(control).not.toContain("50%");
});

it("does not present prior values as current while reconnecting or after a failed history read", () => {
  const thread = freshThreadState("one", "fixture", "/fixture", "one");
  thread.usage = { used: 50, size: 100 };
  thread.reconnecting = true;
  expect(renderToStaticMarkup(<ThreadUsage thread={thread} />)).not.toContain(
    "50%",
  );
  thread.reconnecting = false;
  thread.historyUnavailable = { reason: "empty", sourceKnown: true };
  expect(renderToStaticMarkup(<ThreadUsage thread={thread} />)).not.toContain(
    "50%",
  );
  expect(
    renderToStaticMarkup(<ThreadUsageDetails thread={thread} />),
  ).toContain("此前收到的数据");
});

it("separates a nullable single-message report from context and totals without inventing currency or completion", async () => {
  const { receiveMessageUsage } = await import("../runtime/message_usage");
  const thread = freshThreadState("one", "fixture", "/fixture", "one");
  thread.connectionId = "connection";
  const usage = {
    messageId: "opaque-id",
    inputTokens: 12,
    outputTokens: null,
    totalTokens: 999,
    cacheReadTokens: null,
    cacheWriteTokens: 0,
    cost: 0.00001,
    costSource: "estimated",
    elapsedMs: 0,
    timeToFirstTokenMs: null,
    isCompaction: true,
  };
  receiveMessageUsage(thread, {
    kind: "notification",
    method: "official",
    params: { sessionId: "one" },
    presentation: {
      kind: "messageUsage",
      connectionId: thread.connectionId,
      usage,
    },
  });
  const html = renderToStaticMarkup(<ThreadUsageDetails thread={thread} />);
  expect(html).toContain("最近收到的单条消息报告");
  expect(html).toContain("不计入上方累计值");
  expect(html).toContain("999 tokens");
  expect(html).toContain("0 tokens");
  expect(html).toContain("0 ms");
  expect(html).toContain("尚未提供");
  expect(html).toContain("0.00001（币种未提供）");
  expect(html).toContain("估算");
  expect(html).toContain("未与对话中的具体消息关联");
  expect(html).toContain("不代表整理已完成");
  expect(html).not.toContain("USD");
  expect(html).not.toContain("opaque-id");
  expect(thread.usage).toBeNull();
  expect(thread.sessionTokens).toBeNull();
  thread.connectionLost = true;
  expect(
    renderToStaticMarkup(<ThreadUsageDetails thread={thread} />),
  ).not.toContain("999 tokens");
});
