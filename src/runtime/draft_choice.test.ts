import { expect, it } from "vitest";
import { replacesDraftChoice } from "./draft_choice";
it("protects same-Agent drafts when preparation changes source, model, reasoning or service revision", () => {
  const old = {
    agentId: "a",
    service: { id: "service", model: "one", revision: "r1" },
    config: { model: "one", thought_level: "high" },
  };
  expect(
    replacesDraftChoice(old, "a", {
      service: old.service,
      config: { thought_level: "high", model: "one" },
    }),
  ).toBe(false);
  expect(
    replacesDraftChoice(old, "a", {
      ...old,
      service: { ...old.service, revision: "r2" },
    }),
  ).toBe(true);
  expect(replacesDraftChoice(old, "a", { ...old, service: null })).toBe(true);
  expect(
    replacesDraftChoice(old, "a", {
      ...old,
      config: { model: "one", thought_level: "low" },
    }),
  ).toBe(true);
  expect(replacesDraftChoice(old, "b")).toBe(true);
});
