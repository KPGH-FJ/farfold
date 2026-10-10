import { expect, it } from "vitest";
import {
  parseSkillChangeOperation,
  parseSkillChangeCancellation,
  type SkillChangeRequest,
} from "./skill_management_types";
import { operation, written, iid } from "./skill_management.test-support";
const request: SkillChangeRequest = {
  agentId: "fixture",
  requestId: iid,
  action: "inspect",
  cwd: "/controlled",
  target: {
    inventoryRequestId: iid,
    itemId: 0,
    name: "sample:search",
    origin: "repo",
  },
  requestedEnabled: true,
  operationId: null,
};
it("accepts a complete bounded review and refuses frontend authority or unknown fields", () => {
  const op = operation(request, "ready");
  expect(parseSkillChangeOperation(op, request)).toEqual(op);
  for (const change of [
    { requestId: "other" },
    { agentId: "other" },
    { cwd: "/other" },
    { action: "setEnabled" },
    { operationId: iid },
    { path: "/secret" },
    { requestedEnabled: false },
  ])
    expect(() =>
      parseSkillChangeOperation({ ...op, ...change }, request),
    ).toThrow();
  for (const change of [
    { reviewId: "bad" },
    { validForMs: 600000 },
    { rulesAfter: 999 },
    { preservation: "filesUnchanged" },
    { sessionApplicability: "active" },
    { writeScope: { kind: "system", configDisplayPath: "/a" } },
  ])
    expect(() =>
      parseSkillChangeOperation(
        { ...op, review: { ...op.review, ...change } },
        request,
      ),
    ).toThrow();
});
it("rejects target identity drift and unsafe display locations without echoing raw data", () => {
  const op = operation(request, "ready");
  for (const patch of [
    { inventoryRequestId: "x" },
    { itemId: 1 },
    { name: "other" },
    { origin: "user" },
    { displayPath: "x\nprivate" },
    { displayPath: "a".repeat(4097) },
  ])
    expect(() =>
      parseSkillChangeOperation(
        { ...op, target: { ...op.target, ...patch } },
        request,
      ),
    ).toThrow();
});
it("keeps worker cleanup and write facts independent", () => {
  const r = { ...request, action: "setEnabled" as const };
  const op = written(r);
  expect(parseSkillChangeOperation(op, r)).toEqual(op);
  for (const patch of [
    { settled: false },
    { state: "cancelled", code: "cancelled" },
    { writeAck: "none" },
    { writeAck: "unknown" },
    { writeDispatched: false },
    { review: operation(request, "ready").review },
    { observation: null },
    { outcome: "observed" },
  ])
    expect(() => parseSkillChangeOperation({ ...op, ...patch }, r)).toThrow();
});
it("lost acknowledgement may observe matching current state but cannot claim attributed success", () => {
  const r = { ...request, action: "recheck" as const, operationId: iid };
  const op = written(r, "unknown");
  expect(parseSkillChangeOperation(op, r)).toEqual(op);
  expect(() =>
    parseSkillChangeOperation({ ...op, outcome: "verified" }, r),
  ).toThrow();
  const mismatched = {
    ...op,
    outcome: "mismatch",
    observation: {
      ...op.observation,
      skill: "differs",
      reportedEnabled: false,
    },
  };
  expect(parseSkillChangeOperation(mismatched, r)).toEqual(mismatched);
  expect(() =>
    parseSkillChangeOperation({ ...op, outcome: "mismatch" }, r),
  ).toThrow();
});
it("dispatched exact known rejection remains dispatched, broad errors remain unknown", () => {
  const r = { ...request, action: "setEnabled" as const };
  const op = {
    ...operation(r, "ready"),
    state: "failed",
    code: "configurationChanged",
    writeDispatched: true,
    writeAck: "rejected",
    outcome: "rejected",
  };
  expect(parseSkillChangeOperation(op, r)).toEqual(op);
  expect(() =>
    parseSkillChangeOperation({ ...op, writeAck: "unknown" }, r),
  ).toThrow();
  expect(
    parseSkillChangeOperation(
      {
        ...op,
        writeAck: "unknown",
        outcome: "unknown",
        code: "writeUncertain",
      },
      r,
    ).outcome,
  ).toBe("unknown");
});
it("only exact cancellation identity parses and null makes no terminal operation", () => {
  const receipt = {
    agentId: request.agentId,
    requestId: request.requestId,
    cancelRequested: true,
    operation: null,
  };
  expect(parseSkillChangeCancellation(receipt, request)).toBeNull();
  for (const patch of [
    { agentId: "b" },
    { requestId: "b" },
    { cancelRequested: false },
    { extra: true },
  ])
    expect(() =>
      parseSkillChangeCancellation({ ...receipt, ...patch }, request),
    ).toThrow();
});
it("review and operation must describe the same display location", () => {
  const op = operation(request, "ready");
  expect(() =>
    parseSkillChangeOperation(
      {
        ...op,
        review: {
          ...op.review,
          target: {
            ...op.review!.target,
            displayPath: "~/different/skills/search",
          },
        },
      },
      request,
    ),
  ).toThrow();
});
it("cleanup may expose write facts and observation but not a final outcome", () => {
  const r = { ...request, action: "setEnabled" as const };
  const op = {
    ...written(r),
    state: "pendingCleanup",
    phase: "cleaning",
    settled: false,
    writeAck: "rejected",
    outcome: null,
    code: "pendingCleanup",
  };
  expect(parseSkillChangeOperation(op, r).outcome).toBeNull();
  expect(() =>
    parseSkillChangeOperation({ ...op, outcome: "rejected" }, r),
  ).toThrow();
});
