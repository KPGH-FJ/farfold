import { expect, it } from "vitest";
import { flush } from "./extension_inventory.test-support";
import { setup, operation, written, reviewed } from "./mcp_remove.test-support";
it.each([
  ["preserveSiblings", "empty"],
  ["preserveSiblings", "absent"],
  ["mayRemainEmpty", "nonempty"],
] as const)(
  "rejects matching %s review → %s parent while retaining unknown tracking",
  async (parentHandling, parentOutcome) => {
    const h = await setup();
    h.controller.inspect(h.target);
    await flush();
    const op = operation(h.controller.get(h.owner.agentId).request!, true);
    op.review!.parentHandling = parentHandling;
    h.pending.inspect.resolve(op);
    await flush();
    h.controller.confirm(h.owner, h.controller.get(h.owner.agentId).review!);
    await flush();
    const done = written(h.controller.get(h.owner.agentId).request!);
    done.observation!.parentOutcome = parentOutcome;
    h.pending.confirm.resolve(done);
    await flush();
    expect(h.controller.get(h.owner.agentId)).toMatchObject({
      unresolved: true,
      error: "invalidOutput",
      operation: null,
    });
    expect(h.port.confirm).toHaveBeenCalledTimes(1);
    h.close();
  },
);
it("keeps the original parent constraint for readonly observations after a lost acknowledgement", async () => {
  const h = await setup(),
    rev = await reviewed(h);
  h.controller.confirm(h.owner, rev);
  await flush();
  const r = h.controller.get(h.owner.agentId).request!;
  h.pending.confirm.resolve({
    ...written(r),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
    writeAck: "unknown",
    observation: null,
  });
  await flush();
  const original = structuredClone(h.controller.get(h.owner.agentId).operation);
  h.controller.recheck(h.owner.agentId, r.requestId);
  await flush();
  const checked = written(h.controller.get(h.owner.agentId).request!, true);
  checked.observation!.parentOutcome = "nonempty";
  h.pending.recheck.resolve(checked);
  await flush();
  expect(h.controller.get(h.owner.agentId)).toMatchObject({
    unresolved: true,
    error: "invalidOutput",
    operation: null,
    originalOperation: original,
  });
  h.close();
});
