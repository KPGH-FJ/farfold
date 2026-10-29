import { expect, it } from "vitest";
import {
  mcpAddInputError,
  freezeMcpAddInput,
  parseMcpAddOperation,
  parseMcpAddCancellation,
} from "./mcp_add_types";
import { input, request, operation, written } from "./mcp_add.test-support";
import { parseExtensionCapabilities } from "./extension_inventory_types";
import { parseMcpChangeOperation } from "./mcp_management_types";
import {
  request as mcpRequest,
  operation as mcpOperation,
} from "./mcp_management.test-support";
it("retains ordered whitespace/empty/quoted arguments and copies/freezes the input", () => {
  const value = {
    ...input,
    args: ["", 'a "quoted" value', " leading ", "x\\y"],
  };
  const result = freezeMcpAddInput(value);
  expect(result).toEqual(value);
  expect(result).not.toBe(value);
  expect(Object.isFrozen(result.args)).toBe(true);
  value.args[0] = "changed";
  expect(result.args[0]).toBe("");
});
it.each([
  [{ ...input, name: "a..b" }, "invalidName"],
  [{ ...input, name: "a:b" }, "invalidName"],
  [{ ...input, executablePath: "~/bin/tool" }, "invalidExecutablePath"],
  [{ ...input, executablePath: "/a/../tool" }, "invalidExecutablePath"],
  [{ ...input, executablePath: "/a//tool" }, "invalidExecutablePath"],
  [{ ...input, executablePath: "/a/" }, "invalidExecutablePath"],
  [{ ...input, executablePath: "/a\u202e/tool" }, "invalidExecutablePath"],
  [{ ...input, args: ["a\n"] }, "invalidArguments"],
  [{ ...input, args: ["\u200b"] }, "invalidArguments"],
  [{ ...input, args: new Array(1) }, "invalidArguments"],
  [{ ...input, args: Array(65).fill("") }, "invalidArguments"],
  [{ ...input, args: ["界".repeat(342)] }, "invalidArguments"],
  [{ ...input, args: Array(17).fill("x".repeat(1024)) }, "invalidArguments"],
  [{ ...input, env: { KEY: "value" } }, "invalidRequest"],
])("refuses bounded or unsafe form input %#", (value, code) =>
  expect(mcpAddInputError(value)).toBe(code),
);
it.each([
  { ...input, name: "codex_apps" },
  {
    transport: "streamableHttp" as const,
    name: "codex_apps",
    url: "https://endpoint.test/mcp",
  },
])("leaves Agent-specific name admission to the connection layer", (value) => {
  expect(mcpAddInputError(value)).toBeNull();
  expect(freezeMcpAddInput(value)).toEqual(value);
});
it("parses a matching negative result without repeating Agent name policy", () => {
  const expected = {
    ...request,
    target: { ...request.target, name: "codex_apps" },
  };
  const rejected = {
    ...operation(expected),
    state: "failed",
    phase: "complete",
    settled: true,
    outcome: "notDispatched",
    code: "invalidName",
  };
  expect(parseMcpAddOperation(rejected, expected)).toEqual(rejected);
  expect(() =>
    parseMcpAddOperation(
      { ...rejected, target: { ...rejected.target, name: "other" } },
      expected,
    ),
  ).toThrow();
});
it("accepts no trimming, shell splitting or executable probing", () => {
  expect(
    mcpAddInputError({
      ...input,
      name: "a.b",
      executablePath: "/not installed/工具",
      args: ["", "a b", "--key=value"],
    }),
  ).toBeNull();
});
it("parses absent review values strictly and never accepts leaked argv/config authority", () => {
  const op = operation(request, true);
  expect(parseMcpAddOperation(op, request)).toEqual(op);
  for (const delta of [
    { configuredEnabled: false },
    { reportedEnabled: false },
    { nameAvailability: "unknown" },
    { program: input.executablePath },
  ])
    expect(() =>
      parseMcpAddOperation(
        { ...op, review: { ...op.review, ...delta } },
        request,
      ),
    ).toThrow();
  expect(() =>
    parseMcpAddOperation(
      {
        ...op,
        target: {
          ...op.target,
          inputId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        },
      },
      request,
    ),
  ).toThrow();
  expect(() =>
    parseMcpAddOperation(
      { ...op, target: { ...op.target, kind: "mcp" } },
      request,
    ),
  ).toThrow();
});
it("same disabled report can differ in command/arguments without becoming verified", () => {
  const r = { ...request, action: "add" as const },
    op = written(r);
  const mismatch = {
    ...op,
    outcome: "mismatch",
    observation: { ...op.observation, mcp: "different" },
  };
  expect(parseMcpAddOperation(mismatch, r).observation?.reportedEnabled).toBe(
    false,
  );
  expect(() =>
    parseMcpAddOperation({ ...mismatch, outcome: "verified" }, r),
  ).toThrow();
  for (const observation of [
    { ...op.observation, reportedEnabled: true },
    { ...op.observation, configuredEnabled: true },
    { ...op.observation, mcp: "missing" },
  ])
    expect(() => parseMcpAddOperation({ ...op, observation }, r)).toThrow();
});
it("rejects premature review/verified publication and accepts unknown write facts during cleanup", () => {
  const review = operation(request, true);
  expect(() =>
    parseMcpAddOperation(
      { ...review, state: "running", phase: "reading", settled: false },
      request,
    ),
  ).toThrow();
  const r = { ...request, action: "add" as const },
    op = written(r, true);
  expect(
    parseMcpAddOperation(
      {
        ...op,
        state: "pendingCleanup",
        phase: "cleaning",
        settled: false,
        outcome: null,
        code: "pendingCleanup",
      },
      r,
    ).writeAck,
  ).toBe("unknown");
  expect(() =>
    parseMcpAddOperation(
      {
        ...op,
        state: "pendingCleanup",
        phase: "cleaning",
        settled: false,
        outcome: "verified",
      },
      r,
    ),
  ).toThrow();
  expect(() =>
    parseMcpAddCancellation(
      {
        agentId: request.agentId,
        requestId: request.requestId,
        cancelRequested: false,
        operation: null,
      },
      request,
    ),
  ).toThrow();
});
it("legacy capabilities grant no addition and new capability remains source constrained", () => {
  const yes = {
      availability: "available",
      source: "officialCli",
      reason: null,
    },
    no = { availability: "unavailable", source: null, reason: "notReviewed" };
  const caps = {
    selectionId: request.requestId,
    mcpInventory: yes,
    skillsInventory: no,
    skillEnablement: no,
    toolInventory: "unavailable",
  };
  expect(parseExtensionCapabilities(caps).mcpAddition).toBeUndefined();
  expect(
    parseExtensionCapabilities({
      ...caps,
      mcpAddition: { ...yes, source: "officialAppServer" },
    }).mcpAddition?.availability,
  ).toBe("available");
  expect(() =>
    parseExtensionCapabilities({ ...caps, mcpAddition: yes }),
  ).toThrow();
  expect(() =>
    parseExtensionCapabilities({
      ...caps,
      mcpInventory: no,
      mcpAddition: { ...yes, source: "officialAppServer" },
    }),
  ).toThrow();
});

it.each([0x00ad, 0x034f, 0x2028, 0xe0001, 0xd800, 0x1d173, 0xe0fff])(
  "rejects the shared fixed control set U+%s in both program and argument",
  (point) => {
    const value = String.fromCodePoint(point);
    expect(
      mcpAddInputError({ ...input, executablePath: `/tmp/x${value}` }),
    ).toBe("invalidExecutablePath");
    expect(mcpAddInputError({ ...input, args: [value] })).toBe(
      "invalidArguments",
    );
  },
);
it("keeps allowed Unicode and literal spaces/quotes outside the fixed set unchanged", () => {
  const value = {
    ...input,
    executablePath: '/tmp/工具 "program" ',
    args: ["", "空字符串", " leading ", String.fromCodePoint(0x1d172, 0x1d17b)],
  };
  expect(freezeMcpAddInput(value)).toEqual(value);
});

it("limits inspect notDispatched to add failure/cancellation without weakening old domains", () => {
  const failed = {
    ...operation(request, true),
    state: "failed",
    outcome: "notDispatched",
    code: "nameConflict",
    review: null,
  };
  expect(parseMcpAddOperation(failed, request)).toEqual(failed);
  for (const delta of [
    { outcome: null },
    { writeDispatched: true, writeAck: "ok" },
    { state: "ready" },
    { state: "running", settled: false, phase: "reading" },
  ])
    expect(() =>
      parseMcpAddOperation({ ...failed, ...delta }, request),
    ).toThrow();
  const old = {
    ...mcpOperation(mcpRequest, true),
    state: "failed",
    code: "configurationChanged",
    review: null,
  };
  expect(parseMcpChangeOperation(old, mcpRequest)).toEqual(old);
  expect(() =>
    parseMcpChangeOperation({ ...old, outcome: "notDispatched" }, mcpRequest),
  ).toThrow();
});
