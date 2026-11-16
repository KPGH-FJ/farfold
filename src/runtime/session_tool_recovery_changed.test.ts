import { expect, it } from "vitest";
import {
  parseToolRecoveryInspection,
  parseToolRecoveryConfirmation,
} from "./session_tool_recovery_types";
const target = { agentId: "fixture", cwd: "/owned", sessionId: "native" };
const changed = () => ({
  target,
  pending: true,
  operationId: "operation",
  action: "add",
  outcome: "changed",
  canConfirm: true,
  reviewId: "review",
  connectionId: "connection",
  resolution: "acceptCurrent",
  configuration: {
    complete: true,
    items: [
      { name: "Owned", kind: "http", address: "http://127.0.0.1:8910/mcp" },
    ],
  },
});
it.each([
  "missing-intent",
  "wrong-intent",
  "missing-list",
  "incomplete",
  "overflow",
  "unknown-field",
  "private-path",
  "query",
  "userinfo",
  "hidden-header",
  "unknown-kind",
  "invisible-name",
])("refuses an unreviewable changed report: %s", (kind) => {
  const value: any = changed();
  if (kind === "missing-intent") delete value.resolution;
  if (kind === "wrong-intent") value.resolution = "confirmResult";
  if (kind === "missing-list") value.configuration = null;
  if (kind === "incomplete") value.configuration.complete = false;
  if (kind === "overflow")
    value.configuration.items = Array(257).fill(value.configuration.items[0]);
  if (kind === "unknown-field") value.configuration.future = true;
  if (kind === "private-path")
    value.configuration.items[0].address = "http://127.0.0.1:8910/PRIVATE";
  if (kind === "query")
    value.configuration.items[0].address += "?secret=PRIVATE";
  if (kind === "userinfo")
    value.configuration.items[0].address = "http://PRIVATE@127.0.0.1:8910/mcp";
  if (kind === "hidden-header")
    value.configuration.items[0].headers = [
      { name: "Authorization", value: "PRIVATE" },
    ];
  if (kind === "unknown-kind") value.configuration.items[0].kind = "stdio";
  if (kind === "invisible-name")
    value.configuration.items[0].name = "owned\u202ehidden";
  expect(() => parseToolRecoveryInspection(value, target)).toThrow(
    "invalidResponse",
  );
});
it("preserves distinguishable full public addresses and requires the same acceptance intent in the receipt", () => {
  const value = changed();
  value.configuration.items.push({
    name: "Other",
    kind: "http",
    address: "http://127.0.0.1:8910/",
  });
  const inspected = parseToolRecoveryInspection(value, target);
  expect(inspected.configuration?.items.map((item) => item.address)).toEqual([
    "http://127.0.0.1:8910/mcp",
    "http://127.0.0.1:8910/",
  ]);
  const confirmation = {
    target,
    operationId: "operation",
    reviewId: "review",
    connectionId: "connection",
    resolved: true,
    requiresReopen: true,
    resolution: "confirmResult",
  };
  expect(() => parseToolRecoveryConfirmation(confirmation, inspected)).toThrow(
    "invalidResponse",
  );
  expect(() =>
    parseToolRecoveryConfirmation(
      { ...confirmation, resolution: "acceptCurrent" },
      inspected,
    ),
  ).not.toThrow();
});
