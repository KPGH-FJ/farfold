import { expect, it } from "vitest";
import { configCheckMessage, type ConfigCheck } from "./config_check";
import type { ConfigOptionView } from "./session_types";
import { STRINGS } from "./strings";
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

it.each([undefined, "model"])(
  "describes an unknown setting as unconfirmed without inventing endpoints (id: %s)",
  (id) => {
    const check: ConfigCheck = {
      status: "blocked",
      issues: [
        {
          ...(id ? { id } : {}),
          category: "model",
          reason: "unknown",
          expected: null,
          current: null,
        },
      ],
      current: {
        choices: [
          { id: "model", category: "model", type: "select", value: "kept" },
        ],
      },
    };
    const currentOptions: ConfigOptionView[] = [
      {
        id: "model",
        name: "Selected Model",
        category: "model",
        type: "select",
        currentValue: "kept",
        options: [{ value: "kept", name: "Kept Model Label" }],
      },
    ];
    const before = structuredClone({ check, currentOptions });
    const message = configCheckMessage(check, currentOptions);
    expect(message).toContain("设置尚未确认");
    expect(message).toContain(STRINGS.repair.configBlocked);
    expect(message).not.toContain("→");
    expect(message).not.toContain(STRINGS.repair.unknownModel);
    expect(message).not.toContain("Kept Model Label");
    expect(message).not.toContain("kept");
    if (id) expect(message).toContain("Selected Model");
    else expect(message).not.toContain("模型：");
    expect({ check, currentOptions }).toEqual(before);
  },
);

it("retains a real changed pair beside an independent unknown configuration", () => {
  const check: ConfigCheck = {
    status: "blocked",
    issues: [
      {
        category: "model",
        reason: "unknown",
        expected: null,
        current: null,
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        reason: "changed",
        expected: "high",
        current: "medium",
      },
    ],
    current: {},
  };
  const message = configCheckMessage(check, options)!;
  expect(message).toContain("设置尚未确认");
  expect(message).toContain("Reasoning：high → medium");
  expect(message.match(/→/g)).toHaveLength(1);
  expect(message).toContain(STRINGS.repair.configBlocked);
});

it("keeps known missing, unrecorded, record-failed and ready outcomes distinct", () => {
  const check: ConfigCheck = {
    status: "blocked",
    issues: [
      {
        category: "model",
        reason: "missing",
        expected: "original",
        current: null,
      },
    ],
    current: {},
  };
  expect(configCheckMessage(check)).toContain(
    `original → ${STRINGS.repair.unknownModel}`,
  );
  expect(
    configCheckMessage(
      {
        ...check,
        status: "confirmation_required",
        issues: [
          {
            id: "reasoning_effort",
            category: "thought_level",
            reason: "unrecorded",
            expected: null,
            current: "medium",
          },
        ],
      },
      options,
    ),
  ).toContain("无法确认原Reasoning（当前值：medium）");
  expect(configCheckMessage({ ...check, status: "record_failed" })).toBe(
    STRINGS.repair.configRecordFailed,
  );
  expect(
    configCheckMessage({ ...check, status: "ready", issues: [] }),
  ).toBeNull();
  expect(configCheckMessage(null)).toBeNull();
});
