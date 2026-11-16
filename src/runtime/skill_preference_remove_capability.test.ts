import { expect, it } from "vitest";
import { parseExtensionCapabilities } from "./extension_inventory_types";
import { iid } from "./skill_preference_remove.test-support";

const available = {
  availability: "available",
  source: "officialAppServer",
  reason: null,
};
const unavailable = {
  availability: "unavailable",
  source: null,
  reason: "notReviewed",
};
const legacy = {
  selectionId: iid,
  mcpInventory: unavailable,
  skillsInventory: available,
  skillEnablement: available,
  toolInventory: "unavailable",
};

it("old capabilities grant no preference removal, explicit reviewed skill capability does", () => {
  expect(
    parseExtensionCapabilities(legacy).skillPreferenceRemoval,
  ).toBeUndefined();
  expect(
    parseExtensionCapabilities({ ...legacy, skillPreferenceRemoval: available })
      .skillPreferenceRemoval,
  ).toEqual(available);
  expect(
    parseExtensionCapabilities({
      ...legacy,
      skillPreferenceRemoval: { ...unavailable, reason: "busy" },
    }).skillPreferenceRemoval?.availability,
  ).toBe("unavailable");
});

it("rejects unrelated domains, inconsistent skill inventory and extra capability authority", () => {
  for (const skillPreferenceRemoval of [
    { ...available, source: "officialCli" },
    { ...available, reason: "busy" },
    { ...available, support: "verified" },
    { ...unavailable, source: "officialAppServer" },
    { ...unavailable, reason: "private detail" },
  ])
    expect(() =>
      parseExtensionCapabilities({ ...legacy, skillPreferenceRemoval }),
    ).toThrow();
  expect(() =>
    parseExtensionCapabilities({
      ...legacy,
      skillsInventory: unavailable,
      skillPreferenceRemoval: available,
    }),
  ).toThrow();
});
