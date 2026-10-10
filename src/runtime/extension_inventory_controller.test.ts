import { afterEach, expect, it, vi } from "vitest";
import {
  ExtensionInventoryController,
  type InventoryOwner,
} from "./extension_inventory_controller";
import type { InventoryPort } from "./extension_inventory";
import { deferred, flush, ready } from "./extension_inventory.test-support";
const setup = () => {
  const read = deferred();
  const status = deferred();
  const cancel = deferred();
  const port = {
    read: vi.fn<InventoryPort["read"]>(() => read.promise),
    status: vi.fn<InventoryPort["status"]>(() => status.promise),
    cancel: vi.fn<InventoryPort["cancel"]>(() => cancel.promise),
  } satisfies InventoryPort;
  let n = 0;
  let live = true;
  const owner: InventoryOwner = {
    agentId: "a",
    token: {},
    current: () => live,
  };
  const client = new ExtensionInventoryController(
    port,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
  );
  return {
    client,
    port,
    owner,
    read,
    status,
    cancel,
    close: () => {
      live = false;
      client.retire(owner);
    },
  };
};
afterEach(() => vi.useRealTimers());
it("cancellation receipt null never claims stopped or admits successor", async () => {
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  const r = h.client.get("a").request!;
  h.client.cancel("a", r.requestId);
  h.cancel.resolve({
    agentId: "a",
    requestId: r.requestId,
    cancelRequested: true,
    operation: null,
  });
  await flush();
  expect(h.client.get("a").unresolved).toBe(true);
  expect(
    h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
  ).toBe(false);
  h.read.resolve({
    ...r,
    state: "cancelled",
    settled: true,
    code: "cancelled",
  });
  await flush();
  expect(h.client.get("a").unresolved).toBe(false);
});
it("closed owner can settle its exact slot but cannot publish late success", async () => {
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  const r = h.client.get("a").request!;
  h.close();
  await flush();
  h.read.resolve(ready(r));
  await flush();
  expect(h.client.get("a").unresolved).toBe(false);
  expect(h.client.get("a").result).toBeNull();
  expect(h.port.cancel).toHaveBeenCalledWith(r);
});
it("same-agent A-B-A cannot reuse old owner or old action against a new ID", async () => {
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  const old = h.client.get("a").request!;
  h.read.resolve(ready(old));
  await flush();
  const newOwner = { ...h.owner, token: {} };
  h.client.begin(newOwner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  const current = h.client.get("a").request!;
  expect(current.requestId).not.toBe(old.requestId);
  h.client.cancel("a", old.requestId);
  h.client.check("a", old.requestId);
  expect(h.port.cancel).not.toHaveBeenCalled();
  expect(h.port.status).not.toHaveBeenCalled();
});
it("timeout preserves the original promise and requires explicit exact status", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  const r = h.client.get("a").request!;
  await vi.advanceTimersByTimeAsync(101);
  expect(h.client.get("a").unresolved).toBe(true);
  expect(h.port.read).toHaveBeenCalledTimes(1);
  h.client.check("a", r.requestId);
  h.status.reject({ code: "unknownRequest" });
  await flush();
  expect(h.client.get("a").unresolved).toBe(true);
  h.read.resolve(ready(r));
  await flush();
  expect(h.client.get("a").result?.cwd).toBe("/a");
  expect(h.client.get("a").unresolved).toBe(false);
});
it("only fresh read's known pre-admission refusal releases, not a post-timeout rejection", async () => {
  const first = setup();
  first.client.begin(first.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  first.read.reject({ code: "busy" });
  await flush();
  expect(first.client.get("a").unresolved).toBe(false);
  vi.useFakeTimers();
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  await vi.advanceTimersByTimeAsync(101);
  h.read.reject({ code: "busy" });
  await flush();
  expect(h.client.get("a").unresolved).toBe(true);
});
it("synchronous subscriber withdrawal prevents dispatch", async () => {
  const h = setup();
  h.client.subscribe(h.close);
  expect(
    h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
  ).toBe(false);
  await flush();
  expect(h.port.read).not.toHaveBeenCalled();
  expect(h.port.cancel).not.toHaveBeenCalled();
});
it("settled status cannot be rolled back by a late running read reply", async () => {
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  const r = h.client.get("a").request!;
  h.client.check("a", r.requestId);
  h.status.resolve({
    ...r,
    state: "failed",
    settled: true,
    code: "queryFailed",
  });
  await flush();
  h.read.resolve({ ...r, state: "running", settled: false });
  await flush();
  expect(h.client.get("a").operation?.state).toBe("failed");
  expect(h.client.get("a").unresolved).toBe(false);
});
it("preserves old result as stale after a failed reread, never converts failure to []", async () => {
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  h.read.resolve(ready(h.client.get("a").request!));
  await flush();
  h.port.read.mockImplementationOnce(() =>
    Promise.resolve({
      ...h.client.get("a").request!,
      state: "failed",
      settled: true,
      code: "invalidOutput",
    }),
  );
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  expect(h.client.get("a").result?.snapshot.items).toHaveLength(1);
  expect(h.client.get("a").stale).toBe(true);
});
it("does not accept wrong-owner snapshots or raw errors into public state", async () => {
  const h = setup();
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  h.read.resolve(ready({ ...h.client.get("a").request!, agentId: "b" }));
  await flush();
  expect(h.client.get("a").result).toBeNull();
  expect(h.client.get("a").unresolved).toBe(true);
  expect(h.client.get("a").error).toBe("invalidOutput");
});

it("requires the exact capability ticket at dispatch and never retries rejected selection", async () => {
  const h = setup();
  expect(h.client.begin(h.owner, "/a", "")).toBe(false);
  h.client.begin(h.owner, "/a", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await flush();
  expect(h.port.read.mock.calls[0][0]).toMatchObject({
    selectionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  });
  h.read.reject({ code: "selectionChanged" });
  await flush();
  expect(h.client.get("a").unresolved).toBe(false);
  expect(h.client.get("a").error).toBe("selectionChanged");
  expect(h.port.read).toHaveBeenCalledTimes(1);
});
