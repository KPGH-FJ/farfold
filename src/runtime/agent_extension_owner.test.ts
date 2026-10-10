import { expect, it } from "vitest";
import { AgentExtensionOwners } from "./agent_extension_owner";
import type { AgentRow } from "./agents";
const row = (id = "a"): AgentRow => ({
  id,
  name: "fixture",
  source: "custom",
  command: "/controlled/program",
  args: ["entry"],
  env: [["EXAMPLE", "value"]],
  createdAt: 1,
  updatedAt: 1,
  version: null,
  handshake: null,
});
it("keeps the exact selected program across unrelated changes and equivalent fresh rows", () => {
  const tracker = new AgentExtensionOwners();
  const a = row();
  const token = tracker.update([a, row("b")]).get("a");
  expect(
    tracker
      .update([structuredClone(a), { ...row("b"), command: "/other" }])
      .get("a"),
  ).toBe(token);
});
it("retires in-place environment changes and never revives A-B-A or remove/re-add", () => {
  const tracker = new AgentExtensionOwners();
  const a = row();
  const first = tracker.update([a]).get("a");
  a.env[0][1] = "changed";
  expect(tracker.update([a]).get("a")).not.toBe(first);
  a.env[0][1] = "value";
  const restored = tracker.update([a]).get("a");
  expect(restored).not.toBe(first);
  tracker.update([]);
  expect(tracker.update([a]).get("a")).not.toBe(restored);
});
it("separates args/source/revision and exposes no launch or environment fields", () => {
  for (const change of [
    { args: ["different"] },
    { source: "registry" },
    { updatedAt: 2 },
    { command: "/different" },
  ]) {
    const tracker = new AgentExtensionOwners();
    const token = tracker.update([row()]).get("a");
    const next = tracker.update([{ ...row(), ...change }]).get("a");
    expect(next).not.toBe(token);
    expect(Object.keys(next!)).toEqual([]);
  }
});
