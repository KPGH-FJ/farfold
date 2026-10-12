import { afterEach, expect, it, vi } from "vitest";
import {
  expected,
  flush,
  operation,
  selection,
  setup,
} from "./history_search.test-support";
afterEach(() => vi.useRealTimers());
it("only an explicit supported, same-owner start can read history; no native ID or cwd is accepted", async () => {
  const h = setup();
  expect(h.port.capabilities).not.toHaveBeenCalled();
  expect(h.controller.start(h.owner, "hello")).toBe(false);
  await h.prepare();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(h.controller.start(h.owner, "hello")).toBe(true);
  const { rowIds: _ids, ...request } = expected;
  expect(h.port.start).toHaveBeenCalledExactlyOnceWith(request);
  expect(h.controller.start(h.owner, "hello")).toBe(false);
});
it("unsupported selection remains unavailable and never dispatches", async () => {
  const h = setup();
  h.port.capabilities.mockResolvedValue({
    ...selection(),
    selectionId: null,
    availability: "unavailable",
    code: "unsupported",
    rows: [
      { rowId: "saved-1", availability: "unavailable", code: "unsupported" },
    ],
  });
  expect(await h.prepare()).toBe(false);
  expect(h.controller.start(h.owner, "hello")).toBe(false);
  expect(h.port.start).not.toHaveBeenCalled();
});
it("expired tickets cannot start; explicit capability refresh is required", async () => {
  const h = setup();
  await h.prepare();
  h.setTime(300000);
  expect(h.controller.start(h.owner, "hello")).toBe(false);
  expect(h.port.start).not.toHaveBeenCalled();
});
it("late capabilities after retirement and same-valued new owner do not regrant authority", async () => {
  const h = setup();
  h.port.capabilities.mockReturnValue(h.capability.promise);
  const pending = h.prepare();
  h.close();
  h.capability.resolve(selection());
  await pending;
  expect(h.controller.get("fixture").selection).toBeNull();
  expect(h.controller.start({ ...h.owner, current: () => true }, "hello")).toBe(
    false,
  );
});
it("synchronous retirement at publication fences the start and exact-cancels before admission", async () => {
  const h = setup();
  await h.prepare();
  const off = h.controller.subscribe(() => {
    if (h.controller.get("fixture").flight) h.close();
  });
  expect(h.controller.start(h.owner, "hello")).toBe(false);
  off();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(h.port.cancel).toHaveBeenCalledExactlyOnceWith({
    agentId: expected.agentId,
    requestId: expected.requestId,
  });
});
it("closing clears both retained and late hit bodies while retaining safe tracking", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.close();
  h.start.resolve(operation("completed", 2));
  await flush();
  const flight = h.controller.get("fixture").flight!;
  expect(flight.operation?.settled).toBe(true);
  expect(flight.operation?.hits).toEqual([]);
  expect(flight.owner).toBeNull();
  expect(JSON.stringify(flight)).not.toContain("PRIVATE_BODY");
  expect(h.controller.trackedAgents()).toEqual(["fixture"]);
});
it("closing after completed results drops body but does not cancel a finished worker", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.start.resolve(operation("completed", 2));
  await flush();
  h.close();
  expect(h.port.cancel).not.toHaveBeenCalled();
  expect(h.controller.get("fixture").flight?.operation?.hits).toEqual([]);
});
it("late lower revisions cannot roll back cancellation progress or settled results", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.controller.cancel("fixture", expected.requestId);
  h.cancel.resolve(operation("cancelling", 2));
  await flush();
  h.start.resolve(operation("running", 0));
  await flush();
  expect(h.controller.get("fixture").flight?.operation?.state).toBe(
    "cancelling",
  );
  h.controller.check("fixture", expected.requestId);
  h.status.resolve(operation("cancelled", 3));
  await flush();
  expect(h.controller.get("fixture").flight?.operation?.state).toBe(
    "cancelled",
  );
});
it("timeout and bare errors never prove failed/settled and cannot allow another start", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  await vi.advanceTimersByTimeAsync(101);
  expect(h.controller.get("fixture").flight?.unconfirmed).toBe(true);
  expect(h.controller.get("fixture").flight?.operation).toBeNull();
  expect(h.controller.start(h.owner, "hello")).toBe(false);
  h.controller.check("fixture", expected.requestId);
  h.status.reject({ code: "invalidRequest" });
  await flush();
  expect(h.controller.get("fixture").flight?.operation).toBeNull();
  expect(await h.controller.dismiss("fixture", expected.requestId)).toBe(false);
});
it("open absent stays unknown; explicit closed absence retires without pretending release success", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.start.resolve({
    kind: "absent",
    agentId: "fixture",
    requestId: expected.requestId,
    scope: "currentProcess",
    admissionClosed: false,
  });
  await flush();
  expect(await h.controller.dismiss("fixture", expected.requestId)).toBe(false);
  h.controller.cancel("fixture", expected.requestId);
  h.cancel.resolve({
    kind: "absent",
    agentId: "fixture",
    requestId: expected.requestId,
    scope: "currentProcess",
    admissionClosed: true,
  });
  await flush();
  h.port.release.mockResolvedValue(false);
  expect(await h.controller.dismiss("fixture", expected.requestId)).toBe(true);
  expect(h.port.release).not.toHaveBeenCalled();
});
it("late start after exact closed absence does not resurrect content or authority", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.close();
  h.cancel.resolve({
    kind: "absent",
    agentId: "fixture",
    requestId: expected.requestId,
    scope: "currentProcess",
    admissionClosed: true,
  });
  await flush();
  h.start.resolve(operation("completed", 3));
  await flush();
  expect(h.controller.get("fixture").flight?.operation).toBeNull();
});
it("partial completed searches preserve exact row coverage rather than claiming all history", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  const result = operation("completed", 2);
  result.operation.rows[0].state = "partial";
  result.operation.rows[0].code = "resultLimit";
  h.start.resolve(result);
  await flush();
  expect(h.controller.get("fixture").flight?.operation).toEqual(
    result.operation,
  );
});
it("mismatched scope/query/IDs stays unconfirmed and never presents foreign text", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  const result = operation("completed", 2);
  result.operation.query = "other";
  h.start.resolve(result);
  await flush();
  expect(h.controller.get("fixture").flight?.error).toBe("invalidOutput");
  expect(h.controller.get("fixture").flight?.operation).toBeNull();
});
it("finished detail release failure preserves observation until a successful explicit retry", async () => {
  const h = setup();
  await h.prepare();
  h.controller.start(h.owner, "hello");
  h.start.resolve(operation("completed", 2));
  await flush();
  h.port.release.mockResolvedValueOnce(false);
  expect(await h.controller.dismiss("fixture", expected.requestId)).toBe(false);
  expect(h.controller.get("fixture").flight).not.toBeNull();
  expect(await h.controller.dismiss("fixture", expected.requestId)).toBe(true);
  expect(h.controller.get("fixture").flight).toBeNull();
});
