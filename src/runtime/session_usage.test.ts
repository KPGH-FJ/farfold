import { expect, it } from "vitest";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";
import { contextPercent } from "./session_usage";

const fresh = () => freshThreadState("usage", "fixture", "/fixture", "one");

it("preserves reported context and cumulative cost without rounding tiny costs", () => {
  const state = fresh();
  applyUpdate(state, {
    sessionUpdate: "usage_update",
    used: 125,
    size: 1000,
    cost: { amount: 0.000001, currency: "USD" },
  });
  expect(state.usage).toEqual({
    used: 125,
    size: 1000,
    cost: { amount: 0.000001, currency: "USD" },
  });
  applyUpdate(state, { sessionUpdate: "usage_update", used: 50, size: 1000 });
  expect(state.usage).toEqual({ used: 50, size: 1000 });
});

it.each([
  {},
  { used: "100", size: 1000 },
  { used: -1, size: 1000 },
  { used: 1.5, size: 1000 },
  { used: Infinity, size: 1000 },
  { used: 100, size: Number.MAX_SAFE_INTEGER + 1 },
])(
  "does not turn malformed reports into measured zero or carry a previous report: %j",
  (update) => {
    const state = fresh();
    applyUpdate(state, { sessionUpdate: "usage_update", used: 50, size: 1000 });
    applyUpdate(state, { sessionUpdate: "usage_update", ...update });
    expect(state.usage).toBeNull();
  },
);

it.each([
  { amount: -1, currency: "USD" },
  { amount: NaN, currency: "USD" },
  { amount: "1", currency: "USD" },
  { amount: 1, currency: "" },
  { amount: 1, currency: "<script>" },
])("keeps valid context when only cost is malformed: %j", (cost) => {
  const state = fresh();
  applyUpdate(state, { sessionUpdate: "usage_update", used: 0, size: 0, cost });
  expect(state.usage).toEqual({ used: 0, size: 0 });
});

it("keeps a valid cost even when the context numbers are unavailable", () => {
  const state = fresh();
  applyUpdate(state, {
    sessionUpdate: "usage_update",
    cost: { amount: 0, currency: "CNY" },
  });
  expect(state.usage).toEqual({
    used: null,
    size: null,
    cost: { amount: 0, currency: "CNY" },
  });
});

it("replaces cumulative session totals, does not add reports, and clears missing totals", () => {
  const state = fresh();
  const usage = {
    totalTokens: 300,
    inputTokens: 200,
    outputTokens: 100,
    thoughtTokens: 0,
    cachedReadTokens: 20,
  };
  applyTurnEnd(state, { stopReason: "end_turn", usage });
  applyTurnEnd(state, { stopReason: "end_turn", usage });
  expect(state.sessionTokens).toEqual(usage);
  applyTurnEnd(state, { stopReason: "end_turn" });
  expect(state.sessionTokens).toBeNull();
});

it("does not invent required totals or expose invalid optional totals", () => {
  const state = fresh();
  applyTurnEnd(state, { usage: { totalTokens: 5 } });
  expect(state.sessionTokens).toBeNull();
  applyTurnEnd(state, {
    usage: {
      totalTokens: 5,
      inputTokens: 3,
      outputTokens: 2,
      thoughtTokens: -1,
    },
  });
  expect(state.sessionTokens).toEqual({
    totalTokens: 5,
    inputTokens: 3,
    outputTokens: 2,
  });
});

it("does not divide by zero, clamp overflow, or round a partial window to full", () => {
  expect(contextPercent({ used: 0, size: 0 })).toBeNull();
  expect(contextPercent({ used: 0, size: 1000 })).toBe("0%");
  expect(contextPercent({ used: 1, size: 100000 })).toBe("<0.1%");
  expect(contextPercent({ used: 99999, size: 100000 })).toBe("<100%");
  expect(contextPercent({ used: 1100, size: 1000 })).toBe("110%");
});
