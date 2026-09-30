import { expect, it } from "vitest";
import { configCheckMessage, type ConfigCheck } from "./config_check";
import type { ConfigOptionView } from "./session_types";
const options: ConfigOptionView[] = [
  {
    id: "reasoning_effort",
    category: "thought_level",
    name: "Reasoning",
    type: "select",
    currentValue: "medium",
    options: [],
  },
  {
    id: "thinking_budget",
    category: "thought_level",
    name: "Thinking Budget",
    type: "select",
    currentValue: "0",
    options: [],
  },
];
it("distinguishes simultaneous confirmation issues by their exact public option names", () => {
  const current = {
    choices: [
      {
        id: "reasoning_effort",
        category: "thought_level",
        type: "select",
        value: "medium",
      },
      {
        id: "thinking_budget",
        category: "thought_level",
        type: "select",
        value: "0",
      },
    ],
  };
  const check = {
    status: "confirmation_required",
    issues: options.map((o) => ({
      id: o.id,
      category: "thought_level",
      reason: "unrecorded",
      expected: null,
      current: o.currentValue,
    })),
    protectedIds: options.map((o) => o.id),
    current,
  } as ConfigCheck;
  const before = structuredClone(check);
  const message = configCheckMessage(check, options);
  expect(message).toContain("Reasoning");
  expect(message).toContain("Thinking Budget");
  expect(message).toContain("medium");
  expect(message).toContain("0");
  expect(check).toEqual(before);
});
it("keeps legacy category-only checks readable", () => {
  expect(
    configCheckMessage({
      status: "blocked",
      issues: [
        {
          category: "model",
          reason: "changed",
          expected: "original",
          current: "changed",
        },
      ],
      current: {},
    }),
  ).toContain("original → changed");
});
