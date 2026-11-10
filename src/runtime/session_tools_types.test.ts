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
it("accepts only bounded opening result counts in the current conversation supplement", () => {
  const startup = {
    reportedCount: 257,
    loadedCount: 253,
    failedCount: 1,
    unknownCount: 2,
  };
  const value = { ...capability, startup };
  expect(sessionToolInventoryCapability(value)).toEqual(value);
  for (const patch of [
    { identifier: "PRIVATE_NAME" },
    { error: "PRIVATE_ERROR" },
    { loadedCount: 254 },
    { failedCount: -1 },
    { unknownCount: 0.5 },
  ])
    expect(
      sessionToolInventoryCapability({
        ...capability,
        startup: { ...startup, ...patch },
      }),
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
it("separates a configuration reply and rejects claims or fields outside its public projection", () => {
  const request = { ...target, configuration: true as const };
  const raw = {
    ...pending(request),
    state: "ready",
    settled: true,
    configurationReport: {
      observedAtMs: 1000,
      source: "unreported",
      connectionStatus: "unreported",
      reportedItemCount: 1,
      itemsTruncated: false,
      items: [{ name: "HTTP Test", kind: "http" }],
    },
  };
  expect(
    sessionToolInventoryCapability({ ...capability, configuration: true }),
  ).toEqual({
    ...capability,
    configuration: true,
  });
  expect(
    sessionToolInventoryCapability({
      ...capability,
      configuration: true,
      toolsUnavailable: true,
    }),
  ).toEqual({ ...capability, configuration: true, toolsUnavailable: true });
  expect(
    sessionToolInventoryCapability({ ...capability, toolsUnavailable: true }),
  ).toBeNull();
  expect(parse(raw, request).configurationReport).toEqual(
    raw.configurationReport,
  );
  expect(() => parse(raw, target)).toThrow();
  expect(() => parse(ready(request), request)).toThrow();
  expect(() =>
    parse(
      {
        ...raw,
        configurationReport: {
          ...raw.configurationReport,
          connectionStatus: "connected",
        },
      },
      request,
    ),
  ).toThrow();
  expect(() =>
    parse(
      {
        ...raw,
        configurationReport: {
          ...raw.configurationReport,
          items: [{ ...raw.configurationReport.items[0], url: "PRIVATE" }],
        },
      },
      request,
    ),
  ).toThrow();
});
it("accepts an optional bounded opening scope and binds each response to the requested extension", () => {
  const startup = {
    reportedCount: 2,
    loadedCount: 2,
    failedCount: 0,
    unknownCount: 0,
  };
  const extensions = ["Owned Report", "Another"];
  const scoped = { ...capability, startup, extensions };
  expect(sessionToolInventoryCapability(scoped)).toEqual(scoped);
  expect(
    sessionToolInventoryCapability({ ...scoped, extensions: ["Unknown/path"] }),
  ).toBeNull();
  expect(
    sessionToolInventoryCapability({ ...capability, extensions }),
  ).toBeNull();
  const request = { ...target, extensionName: extensions[0] };
  expect(parse(ready(request), request).extensionName).toBe("Owned Report");
  expect(() =>
    parse(ready({ ...request, extensionName: extensions[1] }), request),
  ).toThrow();
  expect(() => parse(ready(target), request)).toThrow();
  expect(() => parse(ready(request), target)).toThrow();
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
