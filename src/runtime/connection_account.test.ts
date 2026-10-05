import { expect, it } from "vitest";
import { connectionAccount } from "./connection_account";
import type { AgentConnectionStatus } from "./agents";
const status = (
  extra: Partial<AgentConnectionStatus> = {},
): AgentConnectionStatus => ({
  agentId: "fixture",
  cwd: "/work",
  connectionId: "prepare",
  purpose: "preparation",
  state: "ready",
  authMethods: [],
  agentName: null,
  agentVersion: null,
  account: { kind: "account", email: "user@example.test", plan: "pro" },
  ...extra,
});
it("identity declarations and a ready connection do not fabricate a login", () => {
  expect(
    connectionAccount([status({ account: null })], {
      agentId: "fixture",
      cwd: "/work",
    }),
  ).toBeNull();
  expect(
    connectionAccount([status({ account: { kind: "none" } })], {
      agentId: "fixture",
      cwd: "/work",
    }),
  ).toEqual({ kind: "none" });
});
it("reports identity for its exact existing-settings preparation target", () => {
  expect(
    connectionAccount([status()], { agentId: "fixture", cwd: "/work" }),
  ).toEqual({ kind: "account", email: "user@example.test", plan: "pro" });
  for (const extra of [
    { agentId: "other" },
    { cwd: "/other" },
    { serviceContext: "api-revision" },
    { purpose: "conversation" as const },
    { state: "closed" },
  ]) {
    expect(
      connectionAccount([status(extra)], { agentId: "fixture", cwd: "/work" }),
    ).toBeNull();
  }
});
it("an Agent subscription report never replaces a user-selected API service", () => {
  expect(
    connectionAccount([status()], {
      agentId: "fixture",
      cwd: "/work",
      source: "selected-api",
    }),
  ).toBeNull();
});
it("conversation details use that process report rather than the settings account or a sibling", () => {
  const preparing = status();
  const working = status({
    connectionId: "working",
    purpose: "conversation",
    account: { kind: "gateway" },
  });
  const sibling = status({
    connectionId: "sibling",
    purpose: "conversation",
    account: { kind: "api_key" },
  });
  expect(
    connectionAccount([preparing, sibling, working], {
      agentId: "fixture",
      cwd: "/work",
      connectionId: "working",
    }),
  ).toEqual({ kind: "gateway" });
  expect(
    connectionAccount([preparing, sibling], {
      agentId: "fixture",
      cwd: "/work",
      connectionId: "working",
    }),
  ).toBeNull();
});
