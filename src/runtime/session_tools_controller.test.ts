import { afterEach, expect, it, vi } from "vitest";
import {
  getSessionToolsController,
  SessionToolsController,
} from "./session_tools_controller";
import {
  fixture,
  flush,
  pending,
  ready,
  failed,
  capability,
  deferred,
} from "./session_tools.test-support";
import type { SessionToolsRequest } from "./session_tools_types";
import { sessionToolsPort } from "./session_tools";

afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

it("reads the prepared owner once without changing model, service, queue or draft state", async () => {
  const h = fixture();
  const before = JSON.stringify(h.owner);
  expect(h.port.read).not.toHaveBeenCalled();
  expect(h.controller.read()).toBe(true);
  expect(h.controller.read()).toBe(false);
  await flush();
  expect(h.port.read).toHaveBeenCalledExactlyOnceWith({
    agentId: "fixture",
    cwd: "/owned",
    sessionId: "native",
    connectionId: "connection",
    operationId: expect.any(String),
  });
  h.read.resolve(ready(h.request(), []));
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "ready",
    unresolved: false,
    operation: { report: { items: [], completeness: "unreported" } },
  });
  expect(JSON.stringify(h.owner)).toBe(before);
});
it("pending only checks the same known operation, and settled permits a new explicit read", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  const original = h.request();
  h.read.resolve(pending(original));
  await flush();
  expect(h.controller.read()).toBe(false);
  expect(h.controller.check()).toBe(true);
  expect(h.controller.check()).toBe(false);
  await flush();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(original);
  h.status.resolve(ready(original));
  await flush();
  expect(h.controller.check()).toBe(false);
  expect(h.controller.read()).toBe(true);
  await flush();
  expect(h.request().operationId).not.toBe(original.operationId);
  expect(h.port.read).toHaveBeenCalledTimes(2);
});
it("keeps an older report when a known extension returns no tools, and only checks the original scope", async () => {
  const h = fixture();
  h.owner.sessionToolInventory = {
    ...capability,
    startup: {
      reportedCount: 1,
      loadedCount: 1,
      failedCount: 0,
      unknownCount: 0,
    },
    extensions: ["Owned Report"],
  };
  expect(h.controller.read("ownedreport")).toBe(false);
  expect(h.controller.read()).toBe(true);
  await flush();
  h.read.resolve(ready(h.request()));
  await flush();
  const prior = h.controller.getSnapshot().lastReport;
  expect(prior?.value.reportedItemCount).toBe(1);

  const scoped = deferred();
  h.port.read.mockReturnValueOnce(scoped.promise);
  expect(h.controller.read("Owned Report")).toBe(true);
  await flush();
  const request = h.request();
  expect(request.extensionName).toBe("Owned Report");
  expect(h.controller.getSnapshot().lastReport).toBe(prior);
  scoped.resolve(pending(request));
  await flush();
  expect(h.controller.read()).toBe(false);
  expect(h.controller.check()).toBe(true);
  await flush();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(request);
  h.status.resolve(ready(request, []));
  await flush();
  expect(h.port.read).toHaveBeenCalledTimes(2);
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "ready",
    unresolved: false,
    operation: {
      extensionName: "Owned Report",
      report: { reportedItemCount: 0, completeness: "unreported" },
    },
    lastReport: prior,
  });
});
it.each([
  "running",
  "connectionLost",
  "connectionOutcomeUnknown",
  "configuring",
  "stopUnconfirmed",
] as const)("does not read while %s", async (field) => {
  const h = fixture();
  h.owner[field] = true;
  expect(h.controller.read()).toBe(false);
  await flush();
  expect(h.port.read).not.toHaveBeenCalled();
});
it("does not infer a native owner/capability from a draft or ordinary HTTP support", async () => {
  const h = fixture();
  h.owner.nativeSessionId = "";
  expect(h.controller.read()).toBe(false);
  const other = fixture();
  other.owner.sessionToolInventory = null;
  expect(other.controller.blockedCode).toBe("unavailable");
  expect(other.controller.read()).toBe(false);
  await flush();
  expect(other.port.read).not.toHaveBeenCalled();
});
it("retains an unknown delivery ID for status instead of resending read or returning an empty list", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  const original = h.request();
  h.read.reject(new Error("private transport failure"));
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "error",
    error: "queryFailed",
    unresolved: true,
    operationId: original.operationId,
    operation: null,
  });
  expect(h.controller.read()).toBe(false);
  expect(h.controller.check()).toBe(true);
  await flush();
  h.status.resolve(ready(original));
  await flush();
  expect(h.controller.getSnapshot().phase).toBe("ready");
  expect(h.port.read).toHaveBeenCalledTimes(1);
});
it("local timeout preserves pending and a terminal status wins an older pending reply", async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.controller.read();
  await flush();
  const original = h.request();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.controller.getSnapshot()).toMatchObject({
    error: "timeout",
    unresolved: true,
  });
  h.controller.check();
  await flush();
  h.status.resolve(ready(original));
  await flush();
  h.read.resolve(pending(original));
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "ready",
    unresolved: false,
  });
  expect(h.port.read).toHaveBeenCalledTimes(1);
});
it("a locally failed unsettled read remains status-only and does not become empty success", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  h.read.resolve(failed(h.request(), false));
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "error",
    unresolved: true,
    error: "queryFailed",
    operation: { report: null },
  });
  expect(h.controller.read()).toBe(false);
  expect(h.controller.check()).toBe(true);
});
it("a known unsupported connection cannot initiate another actual read", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  h.read.resolve(failed(h.request(), true, "unavailable"));
  await flush();
  expect(h.controller.blockedCode).toBe("unavailable");
  expect(h.controller.read()).toBe(false);
  expect(h.port.read).toHaveBeenCalledTimes(1);
});

it("does not infer unsupported from an unrecognized raw MethodNotFound error", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  h.read.reject({ code: "MethodNotFound", message: "PRIVATE" });
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    error: "queryFailed",
    unresolved: true,
  });
  expect(h.controller.blockedCode).toBeNull();
  expect(h.controller.check()).toBe(true);
});

it("rechecks local busy state before the deferred native read dispatch", async () => {
  const h = fixture();
  h.controller.subscribe(() => {
    h.owner.running = true;
  });
  expect(h.controller.read()).toBe(true);
  await flush();
  expect(h.port.read).not.toHaveBeenCalled();
  expect(h.controller.getSnapshot()).toMatchObject({
    error: "busy",
    unresolved: false,
  });
});

it.each(["id", "fingerprint"] as const)(
  "does not accept a report after service %s changes",
  async (field) => {
    const h = fixture();
    h.owner.service = {
      id: "service",
      model: "selected",
      fingerprint: "source",
    };
    const controller = new SessionToolsController(
      h.owner,
      () => h.owner,
      h.port,
      100,
      () => "owned-read",
    );
    controller.read();
    await flush();
    const original = h.request();
    h.owner.service![field] = "replacement";
    h.read.resolve(ready(original));
    await flush();
    expect(controller.isCurrent()).toBe(false);
    expect(controller.getSnapshot().operation).toBeNull();
  },
);
it("invalid/wrong-owner results and private errors never become reports", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  h.read.resolve({ ...ready(h.request()), connectionId: "foreign" });
  await flush();
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "error",
    error: "invalidResponse",
    operation: null,
    unresolved: true,
  });
  h.controller.check();
  await flush();
  h.status.reject({ code: "queryFailed", message: "PRIVATE" });
  await flush();
  expect(JSON.stringify(h.controller.getSnapshot())).not.toContain("PRIVATE");
});
it("a replacement Thread object cannot receive an old report", async () => {
  const h = fixture();
  h.controller.read();
  await flush();
  h.replace({ ...h.owner });
  h.read.resolve(ready(h.request()));
  await flush();
  expect(h.controller.isCurrent()).toBe(false);
  expect(h.controller.getSnapshot().operation).toBeNull();
});
it("panel unsubscription preserves pending, and owner reconnection creates a separate retired boundary", async () => {
  const h = fixture(),
    read = deferred();
  vi.spyOn(sessionToolsPort, "read").mockReturnValue(read.promise);
  const first = getSessionToolsController(h.owner, () => h.owner);
  const listener = vi.fn(),
    unsubscribe = first.subscribe(listener);
  first.read();
  await flush();
  unsubscribe();
  expect(getSessionToolsController(h.owner, () => h.owner)).toBe(first);
  expect(first.read()).toBe(false);
  const original = vi.mocked(sessionToolsPort.read).mock.calls[0][0];
  h.owner.connectionId = "new-connection";
  const second = getSessionToolsController(h.owner, () => h.owner);
  expect(second).not.toBe(first);
  expect(first.isCurrent()).toBe(false);
  h.owner.connectionId = "connection";
  expect(first.isCurrent()).toBe(false);
  read.resolve(ready(original));
  await flush();
  expect(second.getSnapshot().operation).toBeNull();
  expect(first.getSnapshot().operation).toBeNull();
});
it.each([
  "key",
  "agentId",
  "cwd",
  "nativeSessionId",
  "connectionId",
  "serviceContext",
] as const)(
  "drops a late report after changing %s on the captured object",
  async (field) => {
    const h = fixture();
    h.controller.read();
    await flush();
    const original = h.request();
    h.owner[field] = "replacement";
    h.read.resolve(ready(original));
    await flush();
    expect(h.controller.isCurrent()).toBe(false);
    expect(h.controller.getSnapshot().operation).toBeNull();
  },
);
