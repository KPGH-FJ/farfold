import { expect, it } from "vitest";
import { modelChoiceView } from "./model_choice_view";

it("retains every description of a repeated wire identity without mutating frozen declarations", () => {
  const choices = Object.freeze([
    Object.freeze({
      value: "auto",
      name: "Auto",
      group: "One",
      description: "First",
    }),
    Object.freeze({
      value: "auto",
      name: "Automatic",
      group: "Two",
      description: "Second",
    }),
    Object.freeze({
      value: "auto",
      name: "Auto",
      group: "One",
      description: "First",
    }),
  ]);
  const rows = modelChoiceView(["option", "model"], choices);
  expect(rows).toHaveLength(1);
  expect(rows[0].value).toBe("auto");
  expect(rows[0].name).toBe("Auto");
  for (const declared of ["Automatic", "One", "Two", "First", "Second"])
    expect(rows[0].detail).toContain(declared);
  expect(rows[0].searchTerms).toEqual([
    "auto",
    "Auto",
    "Automatic",
    "One",
    "Two",
    "First",
    "Second",
  ]);
  expect(choices).toHaveLength(3);
});

it("keeps same-name different values in original order and makes both identities readable", () => {
  const rows = modelChoiceView(
    ["option", "model"],
    [
      { value: "auto-b", name: "Auto" },
      { value: "auto-a", name: "Auto" },
      { value: "other", name: "Other" },
    ],
  );
  expect(rows.map((row) => row.value)).toEqual(["auto-b", "auto-a", "other"]);
  expect(rows[0].detail).toContain("auto-b");
  expect(rows[1].detail).toContain("auto-a");
  expect(rows[2].detail).toBe("");
});

it("does not share identities across config IDs, service revisions or delimiter-looking values", () => {
  const choice = [{ value: "shared:model", name: "Same" }];
  const keys = [
    ["option", "model"],
    ["option", "model-other"],
    ["service", "source", "r1"],
    ["service", "source", "r2"],
    ["service", "source:r1", "r2"],
    ["service", "source", "r1:r2"],
  ].map((scope) => modelChoiceView(scope, choice)[0].key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(choice).toEqual([{ value: "shared:model", name: "Same" }]);
});
