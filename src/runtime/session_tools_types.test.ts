import { expect, it } from "vitest";
import {
  parseSessionToolsOperation as parse,
  sessionToolInventoryCapability,
  sessionToolsFailure,
} from "./session_tools_types";
import {
  capability,
  target,
  item,
  ready,
  failed,
  pending,
} from "./session_tools.test-support";

it("requires the exact optional current-conversation supplement, not a handshake guess", () => {
  expect(sessionToolInventoryCapability(capability)).toEqual(capability);
  for (const value of [
    undefined,
    null,
    {},
    { ...capability, source: "goose" },
    { ...capability, scope: "global" },
    { ...capability, read: true },
    { agentCapabilities: { mcpCapabilities: { http: true } } },
  ])
    expect(sessionToolInventoryCapability(value)).toBeNull();
  expect(
    sessionToolInventoryCapability(
      Object.assign(Object.create(capability), {
        extra: true,
        unrelated: false,
      }),
    ),
  ).toBeNull();
});
it("empty success remains an unreported-completeness report, distinct from failure", () => {
  expect(parse(ready(target, []), target)).toMatchObject({
    state: "ready",
    report: {
      completeness: "unreported",
      reportedItemCount: 0,
      items: [],
      observedAtMs: 1794051000000,
    },
  });
  expect(parse(failed(target, false), target)).toMatchObject({
    state: "failed",
    settled: false,
    report: null,
    error: { code: "queryFailed" },
  });
  expect(JSON.stringify(parse(failed(), target))).not.toContain(
    "PRIVATE_ERROR",
  );
});
it("rejects every wrong owner/id and unknown authority or schema fields", () => {
  expect(() =>
    parse({ ...ready(), connectionId: "" }, { ...target, connectionId: "" }),
  ).toThrow();
  for (const patch of [
    { operationId: "other" },
    { agentId: "other" },
    { cwd: "/other" },
    { nativeSessionId: "other" },
    { connectionId: "other" },
    { complete: true },
  ])
    expect(() => parse({ ...ready(), ...patch }, target)).toThrow();
  for (const patch of [
    { completeness: "complete" },
    { complete: true },
    { source: "mcp" },
    { observedAtMs: -1 },
  ]) {
    const raw = ready();
    expect(() =>
      parse({ ...raw, report: { ...raw.report, ...patch } }, target),
    ).toThrow();
  }
  expect(() =>
    parse(ready(target, [{ ...item, inputSchema: {} }]), target),
  ).toThrow();
});
it("validates the count/truncation relation without calling the report complete", () => {
  const raw = ready(
    target,
    Array.from({ length: 256 }, () => item),
  );
  const truncated = {
    ...raw,
    report: { ...raw.report, reportedItemCount: 300, itemsTruncated: true },
  };
  expect(parse(truncated, target).report).toMatchObject({
    reportedItemCount: 300,
    itemsTruncated: true,
    completeness: "unreported",
  });
  for (const patch of [
    { reportedItemCount: 255 },
    { itemsTruncated: false },
    { reportedItemCount: 256 },
  ])
    expect(() =>
      parse(
        { ...truncated, report: { ...truncated.report, ...patch } },
        target,
      ),
    ).toThrow();
  expect(
    parse(
      ready(target, [{ ...item, name: "字".repeat(256), nameTruncated: true }]),
      target,
    ).report?.items[0].name,
  ).toHaveLength(256);
  expect(() =>
    parse(ready(target, [{ ...item, name: "字".repeat(257) }]), target),
  ).toThrow();
});
it("only accepts safe projected strings, official permission values and consistent flags", () => {
  expect(
    parse(ready(target, [{ ...item, description: "line\n\tindent" }]), target)
      .report?.items[0].description,
  ).toBe("line\n\tindent");
  for (const permission of ["always_allow", "ask_before", "never_allow", null])
    expect(
      parse(ready(target, [{ ...item, permission }]), target).report?.items[0]
        .permission,
    ).toBe(permission);
  for (const patch of [
    { permission: "approved" },
    { name: "" },
    { name: "bad\nname" },
    { description: "bad\rdescription" },
    { description: "x".repeat(2049) },
    { description: null, descriptionTruncated: true },
    { nameTruncated: "true" },
  ])
    expect(() =>
      parse(ready(target, [{ ...item, ...patch }]), target),
    ).toThrow();
});
it("validates lifecycle/error shapes and never exposes error prose", () => {
  expect(parse(pending(), target).settled).toBe(false);
  for (const raw of [
    { ...pending(), settled: true },
    { ...pending(), report: ready().report },
    { ...ready(), settled: false },
    { ...failed(), error: null },
    { ...failed(), report: ready().report },
    { ...failed(), error: { code: "unknown", message: "secret" } },
  ])
    expect(() => parse(raw, target)).toThrow();
  expect(sessionToolsFailure({ code: "timeout", message: "PRIVATE" })).toEqual({
    code: "timeout",
  });
  expect(sessionToolsFailure({ code: "timeout" })).toBeNull();
  expect(
    sessionToolsFailure({ code: "timeout", message: "x", private: true }),
  ).toBeNull();
});
