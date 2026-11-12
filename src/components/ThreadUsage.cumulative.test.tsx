import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadUsageDetails } from "./ThreadUsage";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "../runtime/session_projection";
import { receiveSessionUsage } from "../runtime/session_usage_notification";

function fixture() {
  const state = freshThreadState("owned", "fixture", "/owned", "native");
  state.connectionId = "connection";
  const report = (input: number, output: number) => ({
    kind: "notification",
    method: "official-notification",
    params: { sessionId: "native", update: { original: "retained" } },
    presentation: {
      kind: "sessionUsage",
      connectionId: "connection",
      usage: {
        used: 0,
        contextLimit: 1000000,
        accumulatedInputTokens: input,
        accumulatedOutputTokens: output,
        accumulatedCost: 0.0001,
      },
    },
  });
  const html = () =>
    renderToStaticMarkup(<ThreadUsageDetails thread={state} />);
  return { state, report, html };
}

it("shows official cumulative input and output, including zero, without inventing a total or currency", () => {
  const { state, report, html } = fixture();
  state.sessionTokens = {
    totalTokens: 999,
    inputTokens: 888,
    outputTokens: 111,
    thoughtTokens: 77,
    cachedReadTokens: 66,
  };
  expect(receiveSessionUsage(state, report(0, 1234))).toBe(true);
  const shown = html();
  expect(shown).toContain("<dt>累计输入</dt><dd>0 tokens</dd>");
  expect(shown).toContain("<dt>累计输出</dt><dd>1,234 tokens</dd>");
  expect(shown).toContain("<dt>累计用量</dt><dd>尚未提供</dd>");
  expect(shown).toContain("<dt>累计费用</dt><dd>尚未提供</dd>");
  for (const text of [
    "999 tokens",
    "888 tokens",
    "77 tokens",
    "66 tokens",
    "USD",
    "0.0001",
  ])
    expect(shown).not.toContain(text);
  expect(state.sessionTokens?.totalTokens).toBe(999);
  expect(state.reportedDetails).toHaveProperty("/usage_update/params");
});

it("replaces reports without adding, and keeps cumulative fields across the separate context report", () => {
  const { state, report, html } = fixture();
  receiveSessionUsage(state, report(2345, 678));
  receiveSessionUsage(state, report(2345, 678));
  applyUpdate(state, {
    sessionUpdate: "usage_update",
    used: 35,
    size: 1000000,
  });
  expect(html()).toContain("<dt>累计输入</dt><dd>2,345 tokens</dd>");
  expect(html()).toContain("<dt>累计输出</dt><dd>678 tokens</dd>");
  expect(html()).not.toContain("4,690 tokens");
  receiveSessionUsage(state, report(100, 0));
  expect(html()).toContain("<dt>累计输入</dt><dd>100 tokens</dd>");
  expect(html()).toContain("<dt>累计输出</dt><dd>0 tokens</dd>");
  expect(html()).not.toContain("2,345 tokens");
});

it("lets a later complete official report supersede the hint without mixing the two reports", () => {
  const { state, report, html } = fixture();
  receiveSessionUsage(state, report(2345, 678));
  applyTurnEnd(state, { stopReason: "end_turn" });
  expect(html()).toContain("<dt>累计输入</dt><dd>2,345 tokens</dd>");
  applyTurnEnd(state, {
    stopReason: "end_turn",
    usage: { totalTokens: 9000, inputTokens: 7000, outputTokens: 2000 },
  });
  expect(html()).toContain("<dt>累计用量</dt><dd>9,000 tokens</dd>");
  expect(html()).toContain("<dt>累计输入</dt><dd>7,000 tokens</dd>");
  expect(html()).toContain("<dt>累计输出</dt><dd>2,000 tokens</dd>");
  expect(html()).not.toContain("2,345 tokens");
  applyTurnEnd(state, { stopReason: "end_turn" });
  expect(html()).toContain("<dt>累计输入</dt><dd>尚未提供</dd>");
});

it("does not revive an older hint when two later completions arrive before the panel is read", () => {
  const { state, report, html } = fixture();
  receiveSessionUsage(state, report(2345, 678));
  applyTurnEnd(state, {
    stopReason: "end_turn",
    usage: { totalTokens: 9000, inputTokens: 7000, outputTokens: 2000 },
  });
  applyTurnEnd(state, { stopReason: "end_turn" });
  expect(html()).toContain("<dt>累计输入</dt><dd>尚未提供</dd>");
  expect(html()).not.toContain("2,345 tokens");
});

it("does not show unavailable counters as zero or accept another connection's report", () => {
  const { state, report, html } = fixture();
  expect(html()).toContain("<dt>累计输入</dt><dd>尚未提供</dd>");
  expect(html()).toContain("<dt>累计输出</dt><dd>尚未提供</dd>");
  expect(html()).not.toContain("0 tokens");
  state.connectionId = "other";
  expect(receiveSessionUsage(state, report(5432, 100))).toBe(false);
  expect(html()).not.toContain("5,432 tokens");
});

it.each([
  "connection",
  "native",
  "directory",
  "disconnected",
  "failed history",
  "ended",
  "delivery owner",
])("does not reuse cumulative counters after %s changes", (change) => {
  const { state, report, html } = fixture();
  let current = true;
  receiveSessionUsage(state, report(5432, 100), () => current);
  if (change === "connection") state.connectionId = "other";
  if (change === "native") state.nativeSessionId = "other";
  if (change === "directory") state.cwd = "/other";
  if (change === "disconnected") state.connectionLost = true;
  if (change === "failed history")
    state.historyUnavailable = { reason: "empty", sourceKnown: true };
  if (change === "ended") state.processEndedConnectionId = state.connectionId;
  if (change === "delivery owner") current = false;
  expect(html()).not.toContain("5,432 tokens");
  expect(html()).toContain("<dt>累计输入</dt><dd>尚未提供</dd>");
});
