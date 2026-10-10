import { expect, it, vi } from "vitest";
import { ExtensionInventoryController } from "./extension_inventory_controller";
import { flush } from "./extension_inventory.test-support";
import type { InventoryPort } from "./extension_inventory";

const ticket = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function setup() {
  let n = 0;
  const port = {
    read: vi.fn<InventoryPort["read"]>(async ({ selectionId: _, ...r }) => ({
      ...r,
      state: "ready",
      settled: true,
      snapshot: {
        observedAtMs: 1,
        source: "officialAppServer",
        scope: "officialSkillsForDirectory",
        complete: true,
        errorCount: 0,
        sessionApplicability: "unverified",
        items: [],
      },
    })),
    status: vi.fn(),
    cancel: vi.fn<InventoryPort["cancel"]>(async (r) => ({
      agentId: r.agentId,
      requestId: r.requestId,
      cancelRequested: true,
      operation: null,
    })),
  };
  const owner = { agentId: "fixture", token: {}, current: () => true };
  const c = new ExtensionInventoryController(
    port,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
  );
  return { c, port, owner };
}
it("retains the original request and publication owner with each report", async () => {
  const h = setup();
  h.c.begin(h.owner, "/controlled", ticket, "skills");
  await flush();
  const result = h.c.get("fixture").results.skills!;
  expect(result).toMatchObject({ request: h.c.get("fixture").request });
  expect(Reflect.get(result, "owner")).toBe(h.owner);
});
it("retires the private ready skills authority exactly once while retaining its stale public report", async () => {
  const h = setup();
  h.c.begin(h.owner, "/controlled", ticket, "skills");
  await flush();
  const r = h.c.get("fixture").request;
  h.c.retire(h.owner);
  h.c.retire(h.owner);
  await flush();
  expect(h.port.cancel).toHaveBeenCalledExactlyOnceWith(r);
  expect(h.c.get("fixture").results.skills?.stale).toBe(true);
  expect(h.c.get("fixture").unresolved).toBe(false);
});
