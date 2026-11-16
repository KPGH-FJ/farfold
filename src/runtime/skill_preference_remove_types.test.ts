import { expect, it } from "vitest";
import {
  parseSkillPreferenceRemoveOperation as parse,
  parseSkillPreferenceRemoveCancellation,
  skillPreferenceRemoveFailure,
} from "./skill_preference_remove_types";
import {
  skillChangeFailure,
  parseSkillChangeOperation,
} from "./skill_management_types";
import { mcpRemoveFailure, parseMcpRemoveOperation } from "./mcp_remove_types";
import {
  operation as mcpOperation,
  request as mcpRequest,
} from "./mcp_remove.test-support";
import {
  operation,
  written,
  request,
  iid,
  displayPath,
} from "./skill_preference_remove.test-support";

it("recognizes absent preferences only in the removal domain", () => {
  const code = "preferenceNotConfigured";
  const raw = {
    ...operation(request),
    state: "failed",
    phase: "complete",
    settled: true,
    outcome: "notDispatched",
    code,
  };
  expect(parse(raw, request)).toMatchObject({
    state: "failed",
    outcome: "notDispatched",
    code,
  });
  expect(skillPreferenceRemoveFailure({ code })).toBe(code);
  expect(skillPreferenceRemoveFailure({ code, detail: "private" })).toBeNull();
  expect(skillChangeFailure({ code })).toBeNull();
  expect(mcpRemoveFailure({ code })).toBeNull();
  const { kind: _, ...target } = request.target;
  const legacy = {
    ...request,
    action: "inspect" as const,
    requestedEnabled: false,
    target,
  };
  expect(() =>
    parseSkillChangeOperation(
      {
        ...raw,
        target: { ...target, displayPath },
        requestedEnabled: false,
        outcome: null,
      },
      legacy,
    ),
  ).toThrow();
  expect(() =>
    parseMcpRemoveOperation(
      {
        ...mcpOperation(mcpRequest),
        state: "failed",
        phase: "complete",
        settled: true,
        outcome: "notDispatched",
        code,
      },
      mcpRequest,
    ),
  ).toThrow();
  const remove = { ...request, action: "remove" as const };
  expect(() => parse({ ...raw, action: "remove" }, remove)).toThrow();
  expect(() => parse({ ...written(remove, true), code }, remove)).toThrow();
});

it("keeps reported false separate from removing the configured path preference", () => {
  const inspection = parse(operation(request, true), request);
  expect(inspection.review).toMatchObject({
    configuredEnabled: false,
    reportedEnabled: false,
    requestedEnabled: null,
  });
  const remove = {
    ...request,
    action: "remove" as const,
    target: inspection.review!.target,
  };
  expect(parse(written(remove), remove)).toMatchObject({
    outcome: "verified",
    observation: {
      reportedEnabled: false,
      configuredEnabled: null,
      skill: "reported",
    },
  });
  const review = operation(request, true);
  review.review!.configuredEnabled = true;
  review.review!.reportedEnabled = true;
  expect(parse(review, request).review).toMatchObject({
    configuredEnabled: true,
    reportedEnabled: true,
  });
});

it("rejects another domain, target, owner, or supplied path", () => {
  const raw = operation(request, true);
  for (const target of [
    { ...raw.target, kind: "mcpRemoval" },
    {
      ...raw.target,
      inventoryRequestId: "22222222-2222-2222-2222-222222222222",
    },
    { ...raw.target, itemId: 1 },
    { ...raw.target, name: "other" },
    { ...raw.target, origin: "user" },
    { ...raw.target, displayPath: "other", extra: true },
  ])
    expect(() => parse({ ...raw, target }, request)).toThrow();
  for (const patch of [
    { agentId: "other" },
    { cwd: "/other" },
    { requestedEnabled: false },
    { action: "setEnabled" },
    { operationId: iid },
  ]) {
    expect(() => parse({ ...raw, ...patch }, request)).toThrow();
  }
  expect(() =>
    parse(raw, {
      ...request,
      target: { ...request.target, displayPath: "different" },
    }),
  ).toThrow();
  expect(() =>
    parse(
      {
        ...raw,
        review: {
          ...raw.review,
          target: { ...raw.target, displayPath: "different" },
        },
      },
      request,
    ),
  ).toThrow();
  const { displayPath: _, ...missing } = raw.target;
  expect(() => parse({ ...raw, target: missing }, request)).toThrow();
});

it("requires exactly one removed rule and the fixed preservation contract", () => {
  const raw = operation(request, true);
  for (const patch of [
    { rulesBefore: 0, rulesAfter: 0 },
    { rulesAfter: 2 },
    { rulesAfter: 0 },
    { parentHandling: "mayRemainEmpty" },
    { configuredEnabled: null },
    { reportedEnabled: null },
    { requestedEnabled: false },
    { mutation: "removeDisabledMcp" },
    { preservation: "officialJsonValues" },
    { sessionApplicability: "verified" },
    { validForMs: 1 },
    { writeScope: { kind: "project", configDisplayPath: "private" } },
  ])
    expect(() =>
      parse({ ...raw, review: { ...raw.review, ...patch } }, request),
    ).toThrow();
});

it("requires the official skill observation and absent preference before verified", () => {
  const remove = {
    ...request,
    action: "remove" as const,
    target: { ...request.target, displayPath },
  };
  const raw = written(remove);
  for (const patch of [
    { skill: "missing", reportedEnabled: null },
    { skill: "reported", reportedEnabled: null },
    { configuration: "different" },
    { configuredEnabled: false },
    { parentOutcome: null },
    { mcp: "absent" },
    { sessionApplicability: "verified" },
  ])
    expect(() =>
      parse({ ...raw, observation: { ...raw.observation, ...patch } }, remove),
    ).toThrow();
  expect(
    parse(
      {
        ...raw,
        outcome: "mismatch",
        observation: {
          ...raw.observation,
          skill: "missing",
          reportedEnabled: null,
        },
      },
      remove,
    ).outcome,
  ).toBe("mismatch");
});

it("retains uncertain writes and makes recheck an observation only", () => {
  const remove = { ...request, action: "remove" as const };
  expect(parse(written(remove, true), remove)).toMatchObject({
    writeAck: "unknown",
    outcome: "unknown",
  });
  const recheck = { ...remove, action: "recheck" as const, operationId: iid };
  const observed = { ...written(recheck), writeAck: "unknown" as const };
  expect(parse(observed, recheck)).toMatchObject({
    writeAck: "unknown",
    outcome: "observed",
  });
  expect(() => parse({ ...observed, outcome: "verified" }, recheck)).toThrow();
  expect(() =>
    parse({ ...written(remove, true), state: "ready" }, remove),
  ).toThrow();
});

it("validates cancellation identity and nested operation without granting a review", () => {
  const cancelled = {
    agentId: request.agentId,
    requestId: iid,
    cancelRequested: true,
    operation: null,
  };
  expect(parseSkillPreferenceRemoveCancellation(cancelled, request)).toBeNull();
  expect(() =>
    parseSkillPreferenceRemoveCancellation(
      { ...cancelled, agentId: "other" },
      request,
    ),
  ).toThrow();
  expect(() =>
    parseSkillPreferenceRemoveCancellation(
      {
        ...cancelled,
        operation: { ...operation(request), target: { kind: "mcpRemoval" } },
      },
      request,
    ),
  ).toThrow();
});
