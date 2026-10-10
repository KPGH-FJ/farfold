import { expect, it } from "vitest";
import {
  parseMcpRemoveOperation as parse,
  parseMcpRemoveCancellation,
  mcpRemoveFailure,
  type McpRemoveOperation,
} from "./mcp_remove_types";
import { request, operation, written, id } from "./mcp_remove.test-support";
import { parseMcpChangeOperation } from "./mcp_management_types";
import {
  request as preference,
  operation as preferenceOp,
} from "./mcp_management.test-support";
const remove = { ...request, action: "remove" as const };
const ready = () => written(remove);
it.each(["empty", "absent", "nonempty"] as const)(
  "preserves a verified removal with parent outcome %s",
  (parentOutcome) => {
    const op = ready();
    op.observation!.parentOutcome = parentOutcome;
    expect(parse(op, remove)).toEqual(op);
  },
);
it.each(["stdio", "streamableHttp"] as const)(
  "accepts exact %s review/null intent and refuses enabled review",
  (transport) => {
    const r = { ...request, target: { ...request.target, transport } },
      op = operation(r, true);
    expect(parse(op, r)).toEqual(op);
    expect(() =>
      parse({ ...op, review: { ...op.review, configuredEnabled: true } }, r),
    ).toThrow();
  },
);
it.each([
  { mcp: "absent", reportedEnabled: false },
  { mcp: "present", reportedEnabled: null },
  { configuration: "matching", configuredEnabled: false },
  { configuration: "matching", parentOutcome: null },
  {
    configuration: "different",
    parentOutcome: "empty",
    configuredEnabled: true,
  },
  {
    configuration: "different",
    parentOutcome: "absent",
    configuredEnabled: false,
  },
  { sessionApplicability: "connected" },
  { secret: "DO_NOT_PUBLISH" },
])("rejects contradictory or extra observation fields %j", (delta) => {
  const op = ready();
  expect(() =>
    parse({ ...op, observation: { ...op.observation, ...delta } }, remove),
  ).toThrow();
});
it("does not confuse present-but-disabled with removal", () => {
  const op = ready();
  op.outcome = "mismatch";
  op.observation = {
    ...op.observation!,
    configuration: "different",
    mcp: "present",
    configuredEnabled: false,
    reportedEnabled: false,
    parentOutcome: "nonempty",
  };
  expect(parse(op, remove)).toEqual(op);
  expect(() => parse({ ...op, outcome: "verified" }, remove)).toThrow();
});
it.each([
  { state: "running", phase: "checking", settled: false, outcome: null },
  {
    state: "pendingCleanup",
    phase: "cleaning",
    settled: false,
    outcome: "verified",
  },
  { state: "ready", code: "cancelled" },
  {
    state: "cancelled",
    code: "cancelled",
    outcome: "unknown",
    observation: null,
  },
  {
    state: "failed",
    code: "writeUncertain",
    outcome: "verified",
    observation: null,
  },
  { observation: null },
  { writeAck: "rejected" },
])("rejects premature or inconsistent completion %j", (delta) => {
  expect(() => parse({ ...ready(), ...delta }, remove)).toThrow();
});
it.each(["failed", "cancelled"] as const)(
  "admits exact inspect %s as notDispatched only",
  (state) => {
    const op = {
      ...operation(),
      state,
      phase: "complete",
      settled: true,
      outcome: "notDispatched",
      code: state === "cancelled" ? "cancelled" : "targetEnabled",
    };
    expect(parse(op, request)).toEqual(op);
    expect(() => parse({ ...op, outcome: null }, request)).toThrow();
  },
);
it("keeps cleanup active with null publication and never equates null intent to false", () => {
  const op = {
    ...operation(remove),
    state: "pendingCleanup",
    phase: "cleaning",
    code: "pendingCleanup",
    writeDispatched: true,
    writeAck: "unknown",
  };
  expect(parse(op, remove)).toEqual(op);
  expect(() => parse({ ...op, requestedEnabled: false }, remove)).toThrow();
  expect(() =>
    parse({ ...op, target: { ...remove.target, kind: "mcp" } }, remove),
  ).toThrow();
  expect(() =>
    parseMcpChangeOperation(
      { ...preferenceOp(preference), requestedEnabled: null },
      { ...preference, requestedEnabled: null } as never,
    ),
  ).toThrow();
});
it.each(["rejected", "unknown"] as const)(
  "accepts observed current absence while retaining inherited %s",
  (writeAck) => {
    const r = {
      ...request,
      action: "recheck" as const,
      requestId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      operationId: id,
    };
    const op = { ...written(r), writeAck };
    expect(parse(op, r)).toEqual(op);
    expect(() => parse({ ...op, outcome: "verified" }, r)).toThrow();
    expect(
      parse(
        {
          ...op,
          state: "failed",
          code: "queryFailed",
          outcome: "unknown",
          observation: null,
        },
        r,
      ),
    ).toMatchObject({ writeAck, outcome: "unknown" });
  },
);
it("only accepts exact removal cancellation and fixed failure codes", () => {
  const op = operation();
  expect(
    parseMcpRemoveCancellation(
      {
        agentId: request.agentId,
        requestId: id,
        cancelRequested: true,
        operation: op,
      },
      request,
    ),
  ).toEqual(op);
  expect(() =>
    parseMcpRemoveCancellation(
      {
        agentId: request.agentId,
        requestId: id,
        cancelRequested: false,
        operation: null,
      },
      request,
    ),
  ).toThrow();
  expect(mcpRemoveFailure({ code: "targetEnabled" })).toBe("targetEnabled");
  expect(mcpRemoveFailure({ code: "invalidArguments" })).toBeNull();
  expect(
    mcpRemoveFailure({ code: "targetEnabled", detail: "private" }),
  ).toBeNull();
});
it("rejects an invented inspection action and non-whitelist rejected code", () => {
  expect(() =>
    parse(operation(), { ...request, action: "setEnabled" } as never),
  ).toThrow();
  const op: McpRemoveOperation = {
    ...ready(),
    state: "failed",
    code: "queryFailed",
    outcome: "rejected",
    observation: null,
    writeAck: "rejected",
  };
  expect(() => parse(op, remove)).toThrow();
});
