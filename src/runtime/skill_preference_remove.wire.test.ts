import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { skillPreferenceRemovePort } from "./skill_preference_remove";
import {
  setup,
  operation,
  written,
  iid,
  rid,
} from "./skill_preference_remove.test-support";
import { flush } from "./extension_inventory.test-support";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.mocked(invoke).mockReset());

it("uses only the five separate preference removal endpoints and exact argument shapes", async () => {
  const key = { agentId: "fixture", requestId: iid };
  await skillPreferenceRemovePort.inspect({
    ...key,
    inventoryRequestId: iid,
    itemId: 0,
  });
  await skillPreferenceRemovePort.confirm({ ...key, reviewId: rid });
  await skillPreferenceRemovePort.status(key);
  await skillPreferenceRemovePort.cancel(key);
  await skillPreferenceRemovePort.recheck({ ...key, operationId: iid });
  expect(vi.mocked(invoke).mock.calls).toEqual([
    [
      "agent_skill_preference_remove_inspect",
      { ...key, inventoryRequestId: iid, itemId: 0 },
    ],
    ["agent_skill_preference_remove_confirm", { ...key, reviewId: rid }],
    ["agent_skill_preference_remove_status", key],
    ["agent_skill_preference_remove_cancel", key],
    ["agent_skill_preference_remove_recheck", { ...key, operationId: iid }],
  ]);
});

it("the default controller uses the actual port through review, remove and observation", async () => {
  const h = await setup(true);
  vi.mocked(invoke).mockImplementation(async (command) => {
    const r = h.controller.get("fixture").request!;
    if (command === "agent_skill_preference_remove_inspect")
      return operation(r, true);
    if (command === "agent_skill_preference_remove_confirm")
      return written(r, true);
    if (command === "agent_skill_preference_remove_recheck")
      return { ...written(r), writeAck: "unknown" };
    if (command === "agent_skill_preference_remove_cancel") return null;
    throw new Error(`Unexpected endpoint ${command}`);
  });
  h.controller.inspect(h.target);
  await flush();
  const review = h.controller.get("fixture").review!;
  expect(review).toHaveProperty("mutation", "removeSkillPathPreference");
  h.controller.confirm(h.owner, review);
  await flush();
  const prior = h.controller.get("fixture").operation!;
  expect(prior.outcome).toBe("unknown");
  h.controller.recheck("fixture", prior.requestId);
  await flush();
  expect(h.controller.get("fixture")).toMatchObject({
    unresolved: false,
    originalOperation: { outcome: "unknown" },
    operation: { outcome: "observed", writeAck: "unknown" },
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([c]) => c === "agent_skill_preference_remove_confirm",
      ),
  ).toHaveLength(1);
  expect(h.legacy.inspect).not.toHaveBeenCalled();
});
