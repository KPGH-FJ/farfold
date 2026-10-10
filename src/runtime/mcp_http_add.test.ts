import { afterEach, expect, it, vi } from "vitest";
import {
  mcpAddInputError,
  freezeMcpAddInput,
  parseMcpAddOperation,
  type McpAddInput,
} from "./mcp_add_types";
import { parseExtensionCapabilities } from "./extension_inventory_types";
import { setup, operation, written } from "./mcp_add.test-support";
import { flush } from "./extension_inventory.test-support";
const http = {
  transport: "streamableHttp",
  name: "new-http",
  url: "HTTPS://endpoint.test:000443/mcp?token=SYNTHETIC&x=&x=+&p=%2f",
} as const;
afterEach(() => vi.useRealTimers());
it("accepts and freezes exact sensitive query bytes without echoing them in the operation", async () => {
  expect(mcpAddInputError(http)).toBeNull();
  expect(freezeMcpAddInput(http as unknown as McpAddInput)).toEqual(http);
  const h = await setup(true);
  expect(
    h.controller.inspect({
      ...h.target,
      input: http as unknown as McpAddInput,
      httpAvailable: true,
    }),
  ).toBe(true);
  await flush();
  const request = h.controller.get(h.owner.agentId).request!;
  expect(request.target).toMatchObject({ transport: "streamableHttp" });
  expect(JSON.stringify(request)).not.toContain(http.url);
  h.pending.inspect.resolve({
    ...operation(request, true),
    review: {
      ...operation(request, true).review,
      mutation: "addDisabledHttpMcp",
    },
  });
  await flush();
  expect(h.controller.get(h.owner.agentId).review).not.toBeNull();
});
it("accepts only explicit HTTP capability, while old stdio capability remains unchanged", () => {
  const yes = {
    availability: "available",
    source: "officialAppServer",
    reason: null,
  };
  const no = {
    availability: "unavailable",
    source: null,
    reason: "notReviewed",
  };
  const value = {
    selectionId: "11111111-1111-1111-1111-111111111111",
    mcpInventory: { ...yes, source: "officialCli" },
    skillsInventory: no,
    skillEnablement: no,
    toolInventory: "unavailable",
    mcpHttpAddition: yes,
  };
  expect(parseExtensionCapabilities(value).mcpHttpAddition).toEqual(yes);
  expect(() =>
    parseExtensionCapabilities({ ...value, mcpInventory: no }),
  ).toThrow();
});
it("keeps an HTTP review strictly paired to its transport and excludes raw URL fields", () => {
  const request = {
    ...operation().target,
    transport: "streamableHttp" as const,
  };
  const expected = { ...operation(), target: request };
  const ready = {
    ...operation(expected, true),
    review: {
      ...operation(expected, true).review,
      mutation: "addDisabledHttpMcp",
    },
  };
  expect(parseMcpAddOperation(ready, expected)).toEqual(ready);
  expect(() =>
    parseMcpAddOperation(
      {
        ...ready,
        review: { ...ready.review, mutation: "addDisabledStdioMcp" },
      },
      expected,
    ),
  ).toThrow();
  expect(() =>
    parseMcpAddOperation(
      { ...ready, target: { ...request, url: http.url } },
      expected,
    ),
  ).toThrow();
});

async function httpSetup() {
  const h = await setup(true);
  const target = { ...h.target, input: http, httpAvailable: true };
  expect(h.controller.inspect(target)).toBe(true);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  const op = operation(r, true);
  h.pending.inspect.resolve({
    ...op,
    review: { ...op.review, mutation: "addDisabledHttpMcp" },
  });
  await flush();
  return { ...h, target, review: h.controller.get(h.owner.agentId).review! };
}
it("missing HTTP capability never borrows stdio addition authority", async () => {
  const h = await setup();
  expect(h.controller.inspect({ ...h.target, input: http })).toBe(false);
  expect(h.port.inspect).not.toHaveBeenCalled();
});
it("retirement drops HTTP view and retained target data before a late inspection, without releasing tracking", async () => {
  const h = await setup();
  h.controller.inspect({ ...h.target, input: http, httpAvailable: true });
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  const entries = (
    h.controller as unknown as { entries: Map<string, { target: object }> }
  ).entries;
  expect(JSON.stringify(entries.get(h.owner.agentId)!.target)).not.toContain(
    http.url,
  );
  h.controller.retireAddition(h.owner, h.target.inputId);
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
  expect(h.controller.get(h.owner.agentId).unresolved).toBe(true);
  const ready = operation(r, true);
  h.pending.inspect.resolve({
    ...ready,
    review: { ...ready.review, mutation: "addDisabledHttpMcp" },
  });
  await flush();
  expect(h.controller.get(h.owner.agentId).review).toBeNull();
  expect(JSON.stringify([...entries.values()])).not.toContain(http.url);
});
it("after HTTP confirm dispatch, close drops input but preserves unknown and readonly observation without reviving confirmation", async () => {
  const h = await httpSetup();
  expect(h.controller.confirm(h.owner, h.review)).toBe(true);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.controller.retireAddition(h.owner, h.target.inputId);
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
  const unknown = {
    ...written(r, true),
    state: "failed",
    code: "writeUncertain",
    observation: null,
  };
  h.pending.confirm.resolve(unknown);
  await flush();
  expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe("unknown");
  expect(h.controller.recheck(h.owner.agentId, r.requestId)).toBe(true);
  await flush();
  const check = h.controller.get(h.owner.agentId).request!;
  h.pending.recheck.resolve({ ...written(check), writeAck: "unknown" });
  await flush();
  const view = h.controller.get(h.owner.agentId);
  expect(view.operation?.outcome).toBe("observed");
  expect(view.originalOperation).toEqual(unknown);
  expect(view.additionInput).toBeNull();
  expect(h.controller.canConfirm(h.owner, h.review)).toBe(false);
  expect(h.port.confirm).toHaveBeenCalledOnce();
  expect(h.port.recheck).toHaveBeenCalledExactlyOnceWith({
    agentId: h.owner.agentId,
    requestId: check.requestId,
    operationId: r.requestId,
  });
});
it("synchronous retirement before HTTP dispatch prevents any inspect and clears input", async () => {
  const h = await setup();
  const stop = h.controller.subscribe(() => {
    if (h.controller.get(h.owner.agentId).additionInput)
      h.controller.retire(h.owner);
  });
  expect(
    h.controller.inspect({ ...h.target, input: http, httpAvailable: true }),
  ).toBe(false);
  await flush();
  stop();
  expect(h.port.inspect).not.toHaveBeenCalled();
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
});
it("owner loss between confirm scheduling and IPC clears the HTTP input without dispatch", async () => {
  const h = await httpSetup();
  expect(h.controller.confirm(h.owner, h.review)).toBe(true);
  h.owner.current = () => false;
  await flush();
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
  expect(h.controller.get(h.owner.agentId).unresolved).toBe(false);
});
it("starting readonly recheck retires HTTP input before waiting for its reply", async () => {
  const h = await httpSetup();
  h.controller.confirm(h.owner, h.review);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.confirm.resolve(written(r));
  await flush();
  expect(h.controller.recheck(h.owner.agentId, r.requestId)).toBe(true);
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
  expect(h.controller.canConfirm(h.owner, h.review)).toBe(false);
  h.pending.recheck.resolve({
    ...written(h.controller.get(h.owner.agentId).request!),
  });
  await flush();
});
it.each(["reviewExpired", "reviewConsumed"])(
  "fresh confirmation %s retires raw HTTP review data, but does not fabricate a worker result",
  async (code) => {
    const h = await httpSetup();
    h.controller.confirm(h.owner, h.review);
    await flush();
    h.pending.confirm.reject({ code });
    await flush();
    const view = h.controller.get(h.owner.agentId);
    expect(view.admissionRejected).toBe(true);
    expect(view.operation).toBeNull();
    expect(view.additionInput).toBeNull();
    expect(view.unresolved).toBe(false);
    expect(h.controller.canConfirm(h.owner, h.review)).toBe(false);
  },
);
it("exact cancel-null releases only expired tracking and retains no HTTP URL", async () => {
  const h = await setup();
  h.controller.inspect({ ...h.target, input: http, httpAvailable: true });
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.inspect.reject({ code: "unknownRequest" });
  await flush();
  h.controller.cancel(h.owner.agentId, r.requestId);
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
  h.pending.cancel.resolve({
    agentId: r.agentId,
    requestId: r.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.controller.get(h.owner.agentId).trackingReleased).toBe(true);
  expect(h.controller.get(h.owner.agentId).operation).toBeNull();
  expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
});
